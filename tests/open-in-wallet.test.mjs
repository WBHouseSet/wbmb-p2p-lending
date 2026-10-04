// "Open this page in a phone wallet" links: no relay, no vendor account — each wallet app's
// own deep link into its built-in browser, where the page connects like any injected wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WALLET_CHOICE_PARAM,
  phoneUrl,
  walletLinks,
  wantsWalletChoice,
} from "../src/open-in-wallet.mjs";

const SITE = "https://wbmb.example/";

describe("open in a phone wallet", () => {
  it("builds each wallet's documented deep link for the page", () => {
    const links = Object.fromEntries(
      walletLinks(SITE).map((l) => [l.id, l.href]),
    );
    assert.deepEqual(Object.keys(links), [
      "metamask",
      "trust",
      "okx",
      "bitget",
      "tokenpocket",
    ]);
    assert.equal(links.metamask, "https://link.metamask.io/dapp/wbmb.example/");
    // 20000714 = BNB Smart Chain in Trust Wallet's coin ids.
    assert.equal(
      links.trust,
      "https://link.trustwallet.com/open_url?coin_id=20000714&url=https%3A%2F%2Fwbmb.example%2F",
    );
    assert.equal(
      links.okx,
      "okx://wallet/dapp/url?dappUrl=https%3A%2F%2Fwbmb.example%2F",
    );
    assert.equal(
      links.bitget,
      "https://bkcode.vip?action=dapp&url=https%3A%2F%2Fwbmb.example%2F",
    );
    const tp = new URL(links.tokenpocket);
    assert.equal(tp.protocol, "tpdapp:");
    assert.deepEqual(JSON.parse(tp.searchParams.get("params")), {
      url: SITE,
      chain: "BSC",
      source: "wbmb-p2p-lending",
    });
  });

  it("keeps the scheme for MetaMask when the page is plain HTTP", () => {
    const [mm] = walletLinks("http://wbmb.example:5000/");
    assert.equal(
      mm.href,
      "https://link.metamask.io/dapp/http://wbmb.example:5000/",
    );
  });

  it("encodes characters that would otherwise break the wallet's own URL", () => {
    const url = "https://wbmb.example/?a=1&b=%2B#x";
    for (const { id, href } of walletLinks(url)) {
      if (id === "metamask") continue; // path form, the wallet takes the rest verbatim
      if (id === "tokenpocket") {
        assert.equal(
          JSON.parse(new URL(href).searchParams.get("params")).url,
          url,
        );
        continue;
      }
      const inner = new URL(href.replace(/^okx:\/\//, "https://okx/"));
      const value = inner.searchParams.get(id === "okx" ? "dappUrl" : "url");
      assert.equal(value, url, id);
    }
  });

  it("refuses anything but an http(s) page, so a link can never carry a script", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://x/",
      "",
    ])
      assert.throws(() => walletLinks(bad), /http/);
  });

  it("the QR address is this page with the wallet-choice marker, without hash or old query", () => {
    const url = phoneUrl("http://wbmb.example:5000/?foo=1#mine");
    assert.equal(url, `http://wbmb.example:5000/?${WALLET_CHOICE_PARAM}=1`);
    assert.equal(wantsWalletChoice(url), true);
    assert.equal(wantsWalletChoice("http://wbmb.example:5000/"), false);
  });
});
