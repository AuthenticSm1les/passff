import PassFF from "../modules/main.js";
import * as PageHelpers from "../modules/page.js";

test("rateInputNames", () => {
  // mock an INPUT element
  const input = {
    type: "text",
    getAttribute: (n) => (n == "id" ? "opt_login" : ""),
    hasAttribute: (n) => n == "id",
  };
  let goodNames = ["login"].map((v) => v.toLowerCase());
  expect(PageHelpers.rateInputNames(input, goodNames)).toEqual(10);
  goodNames = ["opt_login"].map((v) => v.toLowerCase());
  expect(PageHelpers.rateInputNames(input, goodNames)).toEqual(20);
});

test("doAllSecurityChecks", () => {
  let passItemURL = ["https://example.com", "invalid"];
  let currTabURL = "https://cloud.example.com/login?ref=protocols";
  expect(PageHelpers.doAllSecurityChecks(passItemURL, currTabURL)).toEqual({
    errMessage: null,
    currUrl: currTabURL,
    currUrlValid: true,
    passUrl: passItemURL,
    passUrlValid: true,
    protocol: true,
    fullurl: false,
    subdomain: true,
    domain: true,
  });

  passItemURL = ["https://my.example.com"];
  expect(PageHelpers.doAllSecurityChecks(passItemURL, currTabURL)).toEqual({
    errMessage: null,
    currUrl: currTabURL,
    currUrlValid: true,
    passUrl: passItemURL,
    passUrlValid: true,
    protocol: true,
    fullurl: false,
    subdomain: false,
    domain: true,
  });

  passItemURL = ["invalid"];
  expect(PageHelpers.doAllSecurityChecks(passItemURL, currTabURL)).toEqual({
    errMessage: "Invalid URL: invalid",
    currUrl: currTabURL,
    currUrlValid: true,
    passUrl: passItemURL,
    passUrlValid: false,
    protocol: true,
    fullurl: false,
    subdomain: false,
    domain: false,
  });
});

describe("loginLikelySucceeded", () => {
  const origin = "https://example.com/login";

  it("treats a same-URL page that still shows a password field as failed", () => {
    expect(PageHelpers.loginLikelySucceeded(origin, origin, true)).toBe(false);
  });

  it("treats a same-URL page without a password field as succeeded", () => {
    // e.g. an SPA that swaps the login form out for a dashboard in place
    expect(PageHelpers.loginLikelySucceeded(origin, origin, false)).toBe(true);
  });

  it("treats navigation away as succeeded, even if a password field remains", () => {
    // e.g. landing on a page that happens to have an unrelated password field
    expect(
      PageHelpers.loginLikelySucceeded(
        "https://example.com/dashboard",
        origin,
        true,
      ),
    ).toBe(true);
  });

  it("ignores the URL fragment when comparing", () => {
    expect(
      PageHelpers.loginLikelySucceeded(origin + "#panel=2", origin, true),
    ).toBe(false);
  });
});
