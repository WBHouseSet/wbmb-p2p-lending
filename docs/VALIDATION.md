# 검증 기록

검증일: 2026-10-01 · 로컬 프로토타입 v0.1.0 + 서명 가격 오라클

## 최종 결과

| 검증 | 결과 |
|---|---|
| `npm run check` | 성공 |
| `npm test` | 39 passed: 로컬 EVM 22 + 서명 오라클 10 + 가격 계산 7 |
| `npm run build` | 성공, Vite 정적 빌드 |
| `npm run test:browser` | Chromium 6 passed |
| `npm audit` | 알려진 취약점 0 (검증 시점) |
| 기본 화면 접속 | HTTP 200, chain 31337, 브라우저 스크립트 오류 0 |
| 로컬 faucet | 별도 테스트 공개 주소에 모의 자산·가스 지급 성공 |
| 화면 확인 | 데스크톱 1440px / 모바일 390px, 모바일 가로 넘침 없음 |

P2PLending 런타임 크기 12,171 bytes, SignedPricePolicy 5,246 bytes로 EIP-170 한도 24,576 bytes 이내. Solidity optimizer 200 runs, viaIR, EVM target Cancun. 컴파일러 오류 없음. 경고 5건은 모두 OpenZeppelin `ECDSA.sol` 내부의 `error` 식별자 예약어 예고이며 프로젝트 컨트랙트에서 나온 경고는 없음.

환경: Node.js 26.8.1, npm 11.19.0, Solidity 0.8.37, OpenZeppelin 5.6.1, Hardhat 3.18.0, ethers 6.17.0, Vite 8.3.1, Playwright 1.63.0. 정확한 의존성은 package-lock.json 참조.

## 확인한 중요한 경로

- 양방향 게시와 자금 예치, 부분 체결·잔여 취소·만료 회수.
- 각 체결의 담보 분리, 수량 반올림, 두 토큰 잔액 보존.
- 단리 이자·만기 상한·부분 상환·이자만 납부·수수료 나머지.
- 담보 추가 후 청산 회피, 초과담보 반환, 담보 부족 시 대출자 손실 격리.
- 서명 보고서: 2-of-3 수용, 서명 부족·외부인·중복·다른 도메인·변조·round 재사용·소스 괴리 거부.
- 가격 만료 시 체결/정산 거부, 상환/담보 추가/취소/수령 유지.
- 만기형 전체 담보 귀속과 가격형 임계값 경계/회복 처리.
- 토큰 전송 false/revert와 과세 토큰 거부, 전송 실패 후 claim 보존.
- 재진입 실패의 에러 selector가 `ReentrancyGuardReentrantCall`인지 확인.
- 수수료만 모의 소각기로 이동하고 공급자 수령액/담보는 유지.
- 웹 확인 취소, EIP-1193 계정 변경, 잘못된 체인과 사용자 요청 거부.

## 증거의 범위

실제 로컬 EVM 트랜잭션과 브라우저 동작을 검증했다. 실제 WBMB/USDT, Uniswap·LBank 실시간 가격, 실제 MetaMask/Rabby 확장, 공개 테스트넷/메인넷은 검증하지 않았다. 자동화 지갑 provider는 테스트 구현이다. GitHub Actions 설정 파일은 추가했으나 GitHub 원격 실행은 하지 않았다. 이 검증은 독립 보안 감사가 아니다.

화면 미리보기: [preview.png](preview.png). 실행 절차: [README](../README.md).
