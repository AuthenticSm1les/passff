import { jest } from "@jest/globals";
import PassFF from "../modules/main.js";
import { log } from "../modules/util.js";
import * as PassHelpers from "../modules/pass.js";

test("parse the pass tree output", () => {
  const logSpy = jest.spyOn(log, "debug").mockImplementation(() => {});

  const items = PassHelpers.parsePassTree(`Password Store
├── attachments
│   ├── attachA
│   └── attachB
├── dirA
│   ├── dirAA
│   │   ├── example.com
│   │   └── sub.example.co.uk
│   └── dirAB/
│       ├── example.org
│       ├── example.org.meta
│       └── dirABA -> ../dirAA  [recursive, not followed]
└── dirB
    ├── dirBA
    │   ├── foo.com
    │   ├── dirZZZ -> /home/user/.password_store/dirA  [recursive, not followed]
    │   ├── dirZZY -> ../../../dirXYZ  [recursive, not followed]
    │   └── www.bar.org
    └── baz.info
        ├── login
        └── password
`);

  expect(logSpy).toHaveBeenCalledTimes(2);
  expect(logSpy.mock.calls[0][0]).toContain(
    "only relative links are supported, skipping",
  );
  expect(logSpy.mock.calls[0][1]).toBe("dirZZZ");
  expect(logSpy.mock.calls[1][0]).toContain("link points outside the pass dir");
  expect(logSpy.mock.calls[1][1]).toBe("dirZZY");
  logSpy.mockRestore();

  expect(items.map((item) => (!!item ? item.fullKey : "null")).join("\n"))
    .toBe(`
/attachments
/attachments/attachA
/attachments/attachB
/dirA
/dirA/dirAA
/dirA/dirAA/example.com
/dirA/dirAA/sub.example.co.uk
/dirA/dirAB
/dirA/dirAB/example.org
/dirA/dirAB/example.org.meta
/dirA/dirAB/dirABA
/dirA/dirAB/dirABA/example.com
/dirA/dirAB/dirABA/sub.example.co.uk
/dirB
/dirB/dirBA
/dirB/dirBA/foo.com
null
null
/dirB/dirBA/www.bar.org
/dirB/baz.info
/dirB/baz.info/login
/dirB/baz.info/password`);

  const getItem = (fullKey) => PassHelpers.getItemByFullKey(items, fullKey);
  let item = getItem("/dirA/dirAB/dirABA");
  let children = item.children.map(
    (c) => PassHelpers.getItemById(items, c).key,
  );
  expect(children).toEqual(["example.com", "sub.example.co.uk"]);
  expect(item.isLeaf).toBeFalsy();
  expect(item.isField).toBeFalsy();
  expect(item.hasFields).toBeFalsy();
  expect(item.isMeta).toBeFalsy();
  expect(item.hasMeta).toBeFalsy();
  expect(item.isHidden).toBeFalsy();
  expect(item.isBroken).toBeFalsy();

  expect(getItem("/attachments").isHidden).toBeTruthy();
  expect(getItem("/attachments/attachA").isHidden).toBeTruthy();
  expect(getItem("/attachments/attachB").isHidden).toBeTruthy();

  item = getItem("/dirA/dirAB/example.org");
  expect(item.isLeaf).toBeTruthy();
  expect(item.hasMeta).toBeTruthy();

  item = getItem("/dirA/dirAB/example.org.meta");
  expect(item.isLeaf).toBeFalsy();
  expect(item.isMeta).toBeTruthy();

  item = getItem("/dirB/baz.info");
  expect(item.hasFields).toBeTruthy();
  expect(item.isLeaf).toBeFalsy();

  item = getItem("/dirB/baz.info/login");
  expect(item.isField).toBeTruthy();
  expect(item.isLeaf).toBeTruthy();
});

describe("parse the contents of an entry", () => {
  jest
    .spyOn(PassFF.Pass, "getPassExecPromise")
    .mockImplementation((fullKey) => {
      const stdout = {
        "/dirA/entryAA": "bar\nlogin: foo\nurl: example.com\nxtoken: baz\n",
        "/dirA/entryAB": "bar\nlogin: foo\nurl: -> ../dirB/foo\nxtoken: baz\n",
        "/dirA/entryAC": "bar\nfoo\nexample.com\nxtoken: baz\n",
        "/dirA/entryAD": "-> entryAA\nfoo\nexample.com\nxtoken: baz\n",
        "/dirA/entryAE": "bar\nfoo\nhttps://example.com\nxtoken: baz\n",
        "/dirA/entryAF": "bar\n---\nlogin:foo\nurl: example.com\nxtoken: baz\n",
        "/dirA/entryAG/password": "bar\n",
        "/dirA/entryAG/login": "foo\n",
        "/dirA/entryAG/url": "https://example.com\n",
        "/dirA/entryAH": "bar\n",
        "/dirA/entryAH.meta": "login: foo\nurl: example.com\nxtoken: baz\n",
        "/dirA/entryAI": "abc->def\nfoo\nexample.com\nxtoken: baz\n",
        "/dirA/entryAJ": "->d.e%f\nfoo\nexample.com\nxtoken: baz\n",
        "/dirA/foo": "bar\nurl: example.com\n",
        "/dirA/example.com/foo": "bar\nxtoken: baz\n",
        "/dirB/foo": "bar\n\nurl: example.com\nxtoken: baz\n",
        "/dirB/example.com": "bar\nlogin: foo\nxtoken: baz\n",
        "/dirC/example.com/password": "bar\n",
        "/dirC/example.com/login": "foo\n",
      }[fullKey];
      return Promise.resolve({
        stdout: stdout,
        stderr: "",
        exitCode: 0,
      });
    });

  const items = PassHelpers.parsePassTree(`Password Store
├── dirA
│   ├── entryAA
│   ├── entryAB
│   ├── entryAC
│   ├── entryAD
│   ├── entryAE
│   ├── entryAF
│   ├── entryAG
│   │   ├── password
│   │   ├── login
│   │   └── url
│   ├── entryAH
│   ├── entryAH.meta
│   ├── entryAI
│   ├── entryAJ
│   ├── foo
│   └── example.com
│       └── foo
├── dirB
│   ├── foo
│   └── example.com
└── dirC
    └── example.com
        ├── login
        └── password
`);
  const getItem = (fullKey) => PassHelpers.getItemByFullKey(items, fullKey);

  it("ignores '->' inside of passwords", async () => {
    let result = await PassHelpers.getPasswordData(
      items,
      getItem("/dirA/entryAI"),
    );
    expect(result.password).toBe("abc->def");

    result = await PassHelpers.getPasswordData(items, getItem("/dirA/entryAJ"));
    expect(result.password).toBe("->d.e%f");
  });

  it.each([
    "/dirA/entryAA",
    "/dirA/entryAB",
    "/dirA/entryAC",
    "/dirA/entryAD",
    "/dirA/entryAE",
    "/dirA/entryAF",
    "/dirA/entryAG",
    "/dirA/entryAH",
    "/dirA/foo",
    "/dirA/example.com/foo",
    "/dirB/foo",
    "/dirB/example.com",
    "/dirC/example.com",
  ])("correctly parses %s", async (fullKey) => {
    const result = await PassHelpers.getPasswordData(items, getItem(fullKey));
    expect(result.password).toBe("bar");
    expect(result.login).toBe("foo");
    expect(result.url).toEqual(["https://example.com"]);

    if (
      [
        "/dirA/entryAA",
        "/dirA/entryAB",
        "/dirA/entryAC",
        "/dirA/entryAD",
        "/dirA/entryAE",
        "/dirA/entryAF",
        "/dirA/entryAH",
        "/dirA/example.com/foo",
        "/dirB/foo",
        "/dirB/example.com",
      ].indexOf(fullKey) >= 0
    ) {
      expect(result._other["xtoken"]).toEqual(["baz"]);
    }
  });
});

test("hostMatchQuality", () => {
  expect(
    PassHelpers.hostMatchQuality(
      "/personal/cloud/my.example.com",
      "www.my.example.com",
    ),
  ).toBe(406);
  expect(
    PassHelpers.hostMatchQuality(
      "/personal/cloud/example.com",
      "www.my.example.com",
    ),
  ).toBe(404);
  expect(
    PassHelpers.hostMatchQuality(
      "/personal/cloud/example",
      "www.my.example.com",
    ),
  ).toBe(302);
  expect(
    PassHelpers.hostMatchQuality(
      "/personal/cloud/my.example.com",
      "different.com",
    ),
  ).toBe(-1);
  expect(
    PassHelpers.hostMatchQuality(
      "/personal/cloud/my.example.com",
      "cloud.other.org",
    ),
  ).toBe(101);
});

describe("buildDefaultEntryName", () => {
  const url = "https://accounts.example.com/login";

  it("defaults to the store root when there's no context", () => {
    expect(PassHelpers.buildDefaultEntryName(url, undefined)).toBe(
      "/accounts.example.com",
    );
  });

  it("defaults to the store root for an empty candidate list", () => {
    expect(PassHelpers.buildDefaultEntryName(url, [])).toBe(
      "/accounts.example.com",
    );
  });

  it("nests under the matched context's directory", () => {
    let context = { fullKey: "/work/example.com" };
    expect(PassHelpers.buildDefaultEntryName(url, context)).toBe(
      "/work/accounts.example.com",
    );
  });

  it("uses the first item when given a list of candidates", () => {
    let candidates = [
      { fullKey: "/work/example.com" },
      { fullKey: "/personal/example.com" },
    ];
    expect(PassHelpers.buildDefaultEntryName(url, candidates)).toBe(
      "/work/accounts.example.com",
    );
  });
});

describe("replaceLoginInStoredText", () => {
  it("replaces an explicit login field, keeping other lines untouched", () => {
    let text = "hunter2\nlogin: student\nnotes: keep me\n";
    expect(PassHelpers.replaceLoginInStoredText(text, "otheruser")).toBe(
      "hunter2\nlogin: otheruser\nnotes: keep me\n",
    );
  });

  it("matches other configured login field names, not just 'login'", () => {
    // default loginFieldNames includes "user"
    let text = "hunter2\nuser: student\nnotes: keep me";
    expect(PassHelpers.replaceLoginInStoredText(text, "otheruser")).toBe(
      "hunter2\nuser: otheruser\nnotes: keep me",
    );
  });

  it("replaces the implicit line-2 login when no field is named", () => {
    let text = "hunter2\nstudent\nhttps://example.com";
    expect(PassHelpers.replaceLoginInStoredText(text, "otheruser")).toBe(
      "hunter2\notheruser\nhttps://example.com",
    );
  });

  it("appends a login line when none can be identified", () => {
    let text = "hunter2\notpauth: otpauth://totp/x?secret=ABC";
    expect(PassHelpers.replaceLoginInStoredText(text, "otheruser")).toBe(
      "hunter2\notpauth: otpauth://totp/x?secret=ABC\nlogin: otheruser",
    );
  });

  it("appends a login line for a password-only entry", () => {
    expect(PassHelpers.replaceLoginInStoredText("hunter2", "otheruser")).toBe(
      "hunter2\nlogin: otheruser",
    );
  });
});

describe("applyExtraFields", () => {
  it("appends new fields in order", () => {
    expect(
      PassHelpers.applyExtraFields("login: student", [
        { name: "cc-number", value: "6280703190156733" },
        { name: "cc-exp", value: "01/30" },
      ]),
    ).toBe("login: student\ncc-number: 6280703190156733\ncc-exp: 01/30");
  });

  it("replaces the value of a field that already exists (case-insensitive)", () => {
    expect(
      PassHelpers.applyExtraFields("login: student\nNotes: old note", [
        { name: "notes", value: "new note" },
      ]),
    ).toBe("login: student\nnotes: new note");
  });

  it("works when there are no existing other lines", () => {
    expect(
      PassHelpers.applyExtraFields("", [{ name: "notes", value: "hi" }]),
    ).toBe("notes: hi");
  });

  it("skips fields with an empty/whitespace-only name", () => {
    expect(
      PassHelpers.applyExtraFields("login: student", [
        { name: "   ", value: "ignored" },
      ]),
    ).toBe("login: student");
  });

  it("ignores an empty/undefined fields list", () => {
    expect(PassHelpers.applyExtraFields("login: student", undefined)).toBe(
      "login: student",
    );
    expect(PassHelpers.applyExtraFields("login: student", [])).toBe(
      "login: student",
    );
  });

  it("sanitizes colons and newlines out of the field name, and newlines out of the value", () => {
    expect(
      PassHelpers.applyExtraFields("login: student", [
        { name: "weird:name\n", value: "line1\nline2" },
      ]),
    ).toBe("login: student\nweirdname: line1line2");
  });

  it("later duplicate field names in the same call win", () => {
    expect(
      PassHelpers.applyExtraFields("login: student", [
        { name: "notes", value: "first" },
        { name: "notes", value: "second" },
      ]),
    ).toBe("login: student\nnotes: second");
  });
});

describe("buildEntryNameFromTemplate", () => {
  const url = "https://practicetestautomation.com/login";

  it("substitutes <url> and <login> as given in the example template", () => {
    expect(
      PassHelpers.buildEntryNameFromTemplate("www/<url>/<login>", {
        url,
        login: "student",
      }),
    ).toBe("/www/practicetestautomation.com/student");
  });

  it("works with just <url>", () => {
    expect(
      PassHelpers.buildEntryNameFromTemplate("<url>", {
        url,
        login: "student",
      }),
    ).toBe("/practicetestautomation.com");
  });

  it("works with just <login>", () => {
    expect(
      PassHelpers.buildEntryNameFromTemplate("accounts/<login>", {
        url,
        login: "student",
      }),
    ).toBe("/accounts/student");
  });

  it("works with a literal template using neither placeholder", () => {
    expect(
      PassHelpers.buildEntryNameFromTemplate("misc/logins", {
        url,
        login: "student",
      }),
    ).toBe("/misc/logins");
  });

  it("falls back to the hostname for an empty template", () => {
    expect(
      PassHelpers.buildEntryNameFromTemplate("", { url, login: "student" }),
    ).toBe("/practicetestautomation.com");
    expect(
      PassHelpers.buildEntryNameFromTemplate(undefined, {
        url,
        login: "student",
      }),
    ).toBe("/practicetestautomation.com");
  });

  it("collapses extra/duplicate slashes and trims whitespace segments", () => {
    expect(
      PassHelpers.buildEntryNameFromTemplate("  //www//<url>///<login>/ ", {
        url,
        login: "student",
      }),
    ).toBe("/www/practicetestautomation.com/student");
  });

  it("sanitizes a login containing slashes instead of creating subdirectories", () => {
    expect(
      PassHelpers.buildEntryNameFromTemplate("www/<url>/<login>", {
        url,
        login: "weird/name",
      }),
    ).toBe("/www/practicetestautomation.com/weird_name");
  });

  it("neutralizes a path-traversal attempt in a placeholder value", () => {
    // the whole login value stays a single, opaque path segment -- slashes
    // are replaced rather than allowed to introduce new directory levels
    expect(
      PassHelpers.buildEntryNameFromTemplate("www/<url>/<login>", {
        url,
        login: "../../etc/passwd",
      }),
    ).toBe("/www/practicetestautomation.com/.._.._etc_passwd");
  });

  it("replaces a bare '..' login with a safe placeholder", () => {
    expect(
      PassHelpers.buildEntryNameFromTemplate("<url>/<login>", {
        url,
        login: "..",
      }),
    ).toBe("/practicetestautomation.com/_");
  });
});

describe("getItemQuality", () => {
  let itemFromKey = (key) => ({
    fullKey: key,
    isField: false,
    isLeaf: true,
    hasFields: false,
  });
  let getQuality = (item, url, container) =>
    PassHelpers.getItemQuality(itemFromKey(item), url, container).quality;

  let itemFixed = "/personal/cloud/example.com-4922";
  it.each([
    { u: "https://nomatch.com/personal/cloud", c: "", q: -1 },
    { u: "https://www.my.example.com/", c: "", q: 403 },
    { u: "https://www.my.example.com/some/path", c: "", q: 40300 },
    {
      u: "https://www.my.example.com/some/path?with=query&foo=bar",
      c: "",
      q: 4030000,
    },
    {
      u: "https://www.my.example.com:4231/some/path?with=query&foo=bar",
      c: "",
      q: 40300000,
    },
    {
      u: "https://www.my.example.com:4231/some/path?with=query&foo=bar",
      c: "somecont",
      q: 403000000,
    },
    {
      u: "https://www.my.example.com/some/path?personal=cloud&foo=bar",
      c: "",
      q: 4030002,
    },
    {
      u: "https://www.my.example.com/cloud/path?with=query&foo=bar",
      c: "",
      q: 4030100,
    },
    {
      u: "https://www.my.example.com/some/path?personal=query&foo=bar",
      c: "cloud",
      q: 40300011,
    },
    {
      u: "https://www.my.example.com:4922/personal/path?with=query&foo=bar",
      c: "cloud",
      q: 403101001,
    },
  ])(
    `getItemQuality for $u in '$c'`,
    ({ u: url, c: container, q: quality }) => {
      expect(getQuality(itemFixed, url, container)).toBe(quality);
    },
  );
});
