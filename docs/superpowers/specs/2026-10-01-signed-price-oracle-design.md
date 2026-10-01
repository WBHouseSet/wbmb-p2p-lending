# 서명 가격 보고서 오라클 — 설계

작성일: 2026-10-01 · 상태: 승인(사용자 위임), 구현 대상

## 목표

`MockPricePolicy`(단일 보고자, 임의 `setPrices`)를 **서명 보고서 기반 `SignedPricePolicy`**로 교체한다. DESIGN.md 6.3이 요구한 보고서 메타(policyId·roundId·구간 커버리지·유효기한·원자료 해시·서명자)를 온체인에서 검증한다. 로컬 EVM에서 완결되며, 실제 거래소 데이터 수집은 여전히 범위 밖이다.

사용자 결정:
- 보고자 집합·임계값은 생성 시 고정, 변경 함수 없음(owner 없음).
- 보고서는 소스별 값(DEX·LBank)을 담고, 컨트랙트가 min과 소스 괴리를 재계산·검사한다.

## 컨트랙트 `contracts/SignedPricePolicy.sol`

생성자(모두 immutable): `reporters[]`(1~16, 중복·0주소 금지, 저장은 mapping+배열), `threshold`(1≤M≤N), `policyId`(bytes32), `conversionBps`(1~10000), `maxDivergenceBps`(0~10000), `maxAge`(windowEnd 이후 수용 기간, 1시간~7일). EIP-712 도메인: name `WBMB Price Report`, version `1`, chainId, verifyingContract. 체인 ID 강제 없음.

```
struct Report {
  bytes32 policyId; uint64 roundId; uint64 windowStart; uint64 windowEnd;
  uint64 validUntil; uint16 bucketCount;
  uint256 dexLow; uint256 dexCurrent; uint256 cexLow; uint256 cexCurrent; // cex는 조정 전 BMB 가격
  bytes32 rawDataHash;
}
```

`submit(Report calldata r, bytes[] calldata sigs)` — 누구나 호출, 검사 순서:
1. `policyId == 설정값`, `roundId > lastRoundId`.
2. `windowEnd % 1800 == 0`, `windowStart == windowEnd - 336*1800`, `windowEnd <= block.timestamp`, `block.timestamp < validUntil <= windowEnd + maxAge`, `bucketCount == 336`.
3. 네 가격 모두 `0 < p <= 1e30`.
4. `sigs.length >= threshold`; 복구 주소가 엄격 오름차순이고 reporter 집합에 속함.
5. `cexLowAdj = cexLow*conversionBps/10000`, `cexCurAdj` 동일, 둘 다 >0.
6. 괴리: low·current 각 쌍에 대해 `(hi-lo)*10000 <= lo*maxDivergenceBps`.
7. 저장: `weekLow=min(dexLow,cexLowAdj)`, `current=min(dexCurrent,cexCurAdj)`, `validUntil`, `windowEnd`, `lastRoundId`, `rawDataHash`. 이벤트 `ReportAccepted(roundId, weekLow, current, windowEnd, validUntil, rawDataHash, signerCount)`.

`prices()`: `validUntil` 미경과일 때만 `(min(weekLow,current), current)` 반환, 아니면 `STALE_PRICE`.

에러 문자열: `BAD_POLICY`, `OLD_ROUND`, `BAD_WINDOW`, `BAD_VALIDITY`, `BAD_COVERAGE`, `BAD_PRICE`, `NOT_ENOUGH_SIGNATURES`, `BAD_SIGNER`, `DIVERGENCE`, `STALE_PRICE`.

## 오프체인 `src/report-signing.mjs`

- `reportTypes` (EIP-712 타입), `domainFor(chainId, address)`.
- `prepareReport({report, roundId, rawData, validUntil})`: `buildPriceReport` 결과(확장: `dexLow/dexCurrent/cexLow/cexCurrent` 원값 포함)를 `Report` 구조체로 변환. `rawDataHash = keccak256(JSON 직렬화한 입력 구간)`.
- `signReport(signer, domain, report)` → ethers `signTypedData`.
- `submitReport(policy, report, signers[])`: 서명을 **주소 오름차순으로 정렬**해 `submit` 호출.

`prices.mjs`의 `buildPriceReport`는 소스별 low/current(조정 전 cex)를 추가로 반환한다. 기존 `weekLow/current` 필드는 유지.

## 배포·앱·테스트

- `deploy.mjs`: 보고자 = hardhat 계정 4·5·6, threshold 2. `conversionBps=10000`, `maxDivergenceBps=1000`, `maxAge=2h`. 초기 보고서를 데모 데이터로 서명·제출. `deployment.json`에 `reporters`, `threshold`, `policyId` 추가. 반환 fixture에 `reporters`(signer 배열)와 `publishPrices(low, current, {roundId?})` 헬퍼 제공.
- `MockFeeBurner`는 `IPricePolicy`만 쓰므로 변경 없음. `MockPricePolicy`는 삭제.
- `app.js`: 오라클 이름 `SignedPricePolicy`. 상단 가격 표시는 `windowEnd`(관측 종료)·`validUntil`·`lastRoundId`·서명 임계값 `M/N`. 실험실은 로컬 보고자 계정 2명으로 서명한 보고서를 제출(가격 낮추기·시간 경과 모두 동일 경로). 상태 문구 "가격 만료 · 신규 체결 중단" 유지.
- `tests/lending.test.mjs`: `refresh()`를 `publishPrices`로 교체. 새 `tests/oracle.test.mjs`: 임계값 미달·비보고자·중복 서명자·순서 뒤바뀜·낮은 round·동일 round 재제출·미래 windowEnd·과거 validUntil·bucketCount≠336·괴리 초과·조정가 0·다른 chainId 도메인 서명 거부, 정상 2-of-3 수용, 이벤트 필드, 만료 후 STALE_PRICE.
- 브라우저 테스트의 `#set-price` 흐름 유지.
- 문서: README 구현 범위 표·IMPLEMENTATION.md 가격 모듈 절·VALIDATION.md 갱신.

## 범위 밖

실제 LBank/Uniswap v4 수집, 보고자 키 관리·인프라, 보고자 교체, 오라클 영구 장애 정책.
