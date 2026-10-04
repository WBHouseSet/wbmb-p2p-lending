// "Open this page in a phone wallet": each wallet app's own documented deep link into its
// built-in browser, where the page connects through the injected wallet like on a PC. No
// relay server and no vendor account, so no third-party usage limits.
//   MetaMask    https://docs.metamask.io/sdk/guides/use-deeplinks
//   Trust       https://developer.trustwallet.com/developer/develop-for-trust/deeplinking
//   OKX         okx://wallet/dapp/url?dappUrl=<encoded>
//   Bitget      https://web3.bitget.com/zh-CN/docs/configuration/deeplink/
//   TokenPocket https://help.tokenpocket.pro/developer-en/wallet/pull-up-wallet-with-deeplink

/// Query marker on the QR address: a phone browser without a wallet shows the wallet list.
export const WALLET_CHOICE_PARAM = "wallet";

const TRUST_BSC_COIN_ID = 20000714; // BNB Smart Chain in Trust Wallet's coin ids

function pageUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("http(s) 주소만 열 수 있습니다.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error("http(s) 주소만 열 수 있습니다.");
  return parsed.href;
}

/// The links, in the order the page lists them.
export function walletLinks(url) {
  const page = pageUrl(url);
  const enc = encodeURIComponent(page);
  // MetaMask takes the address as a path and assumes https when the scheme is left out.
  const metamaskTarget = page.startsWith("https://")
    ? page.slice("https://".length)
    : page;
  return [
    {
      id: "metamask",
      name: "MetaMask",
      href: `https://link.metamask.io/dapp/${metamaskTarget}`,
    },
    {
      id: "trust",
      name: "Trust Wallet",
      href: `https://link.trustwallet.com/open_url?coin_id=${TRUST_BSC_COIN_ID}&url=${enc}`,
    },
    {
      id: "okx",
      name: "OKX Wallet",
      href: `okx://wallet/dapp/url?dappUrl=${enc}`,
    },
    {
      id: "bitget",
      name: "Bitget Wallet",
      href: `https://bkcode.vip?action=dapp&url=${enc}`,
    },
    {
      id: "tokenpocket",
      name: "TokenPocket",
      href:
        "tpdapp://open?params=" +
        encodeURIComponent(
          JSON.stringify({
            url: page,
            chain: "BSC",
            source: "wbmb-p2p-lending",
          }),
        ),
    },
  ];
}

/// The address the PC shows as a QR: this page, marked so a phone browser offers the list.
export function phoneUrl(current) {
  const u = new URL(pageUrl(current));
  u.search = `?${WALLET_CHOICE_PARAM}=1`;
  u.hash = "";
  return u.href;
}

export const wantsWalletChoice = (current) =>
  new URL(current).searchParams.has(WALLET_CHOICE_PARAM);
