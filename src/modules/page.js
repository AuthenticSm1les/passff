/**
 * Manipulates and interacts with web pages opened by the user.
 */

import * as util from "./util.js";
import { _, log } from "./util.js";
import PassFF from "./main.js";

let doc = document;
let tabContainer = null;
let inputElements = [];
let loginInputTypes = ["text", "email", "tel"];
let otpInputTypes = ["text", "number", "password", "tel"];
let pwInputTypes = ["password", "text"];
let tabInitPending = [];
let matchItems = [];
let bestFitItem = null;
let goToAutoFillPending = null;
let lastActiveElement = null;

/* #############################################################################
 * #############################################################################
 *  Helpers for DOM analysis
 * #############################################################################
 */

function getActiveElement(doc, depth) {
  depth = depth || 0;
  doc = doc || window.document;
  if (typeof doc.activeElement.contentDocument !== "undefined") {
    if (depth > 5) {
      return false;
    }
    return getActiveElement(doc.activeElement.contentDocument, depth++);
  } else {
    return doc.activeElement;
  }
}

function refocus() {
  if (lastActiveElement !== null) {
    lastActiveElement.focus();
  }
}

function isInvisible(el) {
  return el.offsetHeight === 0 || el.offsetParent === null;
}

function isVisible(el) {
  return !isInvisible(el);
}

function isWritable(el) {
  return !!el && !el.hasAttribute("readonly");
}

function getSubmitButton(form) {
  let buttonQuery = PassFF.Preferences.buttonInputQueries.join(",");
  let buttons = Array.from(form.querySelectorAll(buttonQuery))
    .concat(Array.from(form.elements).filter((el) => el.matches(buttonQuery)))
    .filter(isVisible);
  let submitButtonPredicates = [
    // explicit submit type
    (button) => button.getAttribute("type") === "submit",
    // the browser interprets an unset or invalid type as submit
    (button) => !["submit", "button"].includes(button.getAttribute("type")),
    // assume that last button in form performs submission via javascript
    (button, index, arr) => index + 1 === arr.length,
  ];
  for (let predicate of submitButtonPredicates) {
    let button = buttons.find(predicate);
    if (button) return button;
  }
  return null;
}

function getAutocompleteAttr(input) {
  let autocomplete = input.getAttribute("autocomplete");
  if (input.hasAttribute("passff-autocomplete")) {
    autocomplete = input.getAttribute("passff-autocomplete");
  }
  return autocomplete;
}

function readInputNames(input) {
  let inputNames = PassFF.Preferences.inputAttributes.map((name) => {
    let value = input.getAttribute(name) || "";
    if (name.toLowerCase() == "autocomplete") {
      value = getAutocompleteAttr(input) || "";
      if (["on", "off"].indexOf(value) !== -1) {
        value = "";
      }
    } else if (name.toLowerCase() == "placeholder") {
      if (value.toLowerCase().indexOf("search") !== -1) {
        value = "";
      }
    }
    return value;
  });

  // labels are <label> elements whose `for`-attribute points to this input
  if (input.labels) {
    inputNames = inputNames.concat(
      Array.from(input.labels, (l) => l.innerText),
    );
  }

  if (["email", "tel"].indexOf(input.type) >= 0) {
    inputNames.push(input.type);
  }

  // the first two (usually id and name) have higher influence on the rating
  return inputNames
    .slice(0, 2)
    .concat(inputNames.slice(2).filter(Boolean))
    .map((nm) => nm.toLowerCase());
}

function findIntersection(arr1, arr2, callback) {
  // find first element from arr1 in intersection of arr1 and arr2
  // equality of elements is determined according to callback(el1, el2)
  callback = callback || ((el1, el2) => el1 === el2);
  return arr1.find((el1) => arr2.some((el2) => callback(el1, el2)));
}

export function rateInputNames(input, goodNames) {
  let inputNames = readInputNames(input);
  let rt = inputNames.map((inputName) => {
    let rating = 0;
    for (let gn of goodNames) {
      if (inputName.indexOf(gn) >= 0) {
        rating = 1;
        if (inputName == gn) {
          return 2;
        }
      }
    }
    return rating;
  });
  rt = 10 * (rt[0] + rt[1]) + rt.slice(2).reduce((a, b) => a + b, 0);
  // We ignore `autocomplete="off"` if the rating is at least 10 (which
  // usually means a match in the "id" and/or "name" attribute).
  // https://developer.mozilla.org/en-US/docs/Web/Security/Securing_your_site/Turning_off_form_autocompletion#the_autocomplete_attribute_and_login_fields
  if (getAutocompleteAttr(input) == "off" && rt < 10) {
    rt = 0;
  }
  return rt;
}

function ratePasswordInput(input) {
  if (pwInputTypes.indexOf(input.type) < 0) {
    return 0;
  } else {
    let rt = rateInputNames(input, PassFF.Preferences.passwordInputNames);
    if (input.type === "password" && rt < 10) {
      // just not as good as having a name or id matching an OTP input name exactly
      return 19;
    }
    return rt;
  }
}

function rateLoginInput(input) {
  if (loginInputTypes.indexOf(input.type) < 0) {
    return 0;
  } else {
    return rateInputNames(input, PassFF.Preferences.loginInputNames);
  }
}

function rateOtpInput(input) {
  if (otpInputTypes.indexOf(input.type) < 0) {
    return 0;
  } else {
    return rateInputNames(input, PassFF.Preferences.otpInputNames);
  }
}

/* #############################################################################
 * #############################################################################
 *  Helpers for DOM event handling/simulation
 * #############################################################################
 */

function createFakeEvent(typeArg) {
  if (["keydown", "keyup", "keypress"].includes(typeArg)) {
    return new KeyboardEvent(typeArg, {
      key: " ",
      code: " ",
      charCode: " ".charCodeAt(0),
      keyCode: " ".charCodeAt(0),
      which: " ".charCodeAt(0),
      bubbles: true,
      composed: true,
      cancelable: true,
    });
  } else if (["input", "change"].includes(typeArg)) {
    return new InputEvent(typeArg, {
      bubbles: true,
      composed: true,
      cancelable: true,
    });
  } else if (["focus", "blur"].includes(typeArg)) {
    return new FocusEvent(typeArg, {
      bubbles: true,
      composed: true,
      cancelable: true,
    });
  } else {
    log.error("createFakeEvent: Unknown event type", typeArg);
    return null;
  }
}

function writeValueWithEvents(input, value) {
  // don't fill if element is invisible
  if (isInvisible(input)) return;
  let inputs = [input];
  let values = [value];
  if (input.maxLength == 1) {
    inputs = querySelectorAllShadows("input").filter((el) => el.maxLength == 1);
    if (inputs.length == value.length) {
      values = value.split("");
    } else {
      inputs = [input];
    }
  }
  values.forEach((value, i) => {
    input = inputs[i];
    input.value = value;
    for (let action of [
      "focus",
      "keydown",
      "keyup",
      "keypress",
      "input",
      "change",
      "blur",
    ]) {
      input.dispatchEvent(createFakeEvent(action));
      input.value = value;
    }
  });
}

function annotateInputs(inputs) {
  return inputs.map((input) => {
    let rtLogin = rateLoginInput(input);
    let rtPassword = ratePasswordInput(input);
    let rtOtp = rateOtpInput(input);
    let inputType = "";
    if (rtOtp > rtLogin) {
      if (rtOtp > rtPassword) {
        inputType = "otp";
      } else {
        inputType = "password";
      }
    } else if (rtPassword > rtLogin) {
      inputType = "password";
    } else if (rtLogin > 0) {
      inputType = "login";
    }
    return [input, inputType];
  });
}

function onNodeAdded() {
  inputElements = annotateInputs(
    querySelectorAllShadows("input,select")
      .filter(isVisible)
      .filter(isWritable),
  );
  if (PassFF.Preferences.markFillable) {
    let url = window.location.href;
    let urlInBlacklist = PassFF.Preferences.markFillableBlacklist.findIndex(
      (str) => {
        return url.indexOf(str) >= 0;
      },
    );
    if (urlInBlacklist == -1) {
      inputElements
        .filter((inp) => inp[1] != "")
        .forEach((inp) => attachDropdownTrigger(inp[0], inp[1]));
    }
  }
}

function querySelectorAllShadows(selectors, doc) {
  doc = doc || document;
  return Array.from(doc.querySelectorAll(selectors)).concat(
    Array.from(doc.querySelectorAll("*"))
      .map((el) => el.shadowRoot)
      .filter(Boolean)
      .flatMap((frag) => querySelectorAllShadows(selectors, frag)),
  );
}

/* #############################################################################
 * #############################################################################
 *  Helpers for DOM manipulation
 * #############################################################################
 */

function setInputs(inputs, passwordData) {
  log.debug("setInputs:", inputs);
  let otherNames = Object.keys(passwordData._other);

  // If the number of OTP input fields agrees with the length of the OTP
  // token, fill one digit from the token into each of the input fields.
  let otpInputs = inputs.filter((inp) => inp[1] == "otp");
  let otpFilled = false;
  if (otpInputs.length == passwordData.otp?.length) {
    otpInputs.forEach((annotatedInput, i) => {
      writeValueWithEvents(annotatedInput[0], passwordData.otp[i]);
    });
    otpFilled = true;
  }

  inputs.forEach((annotatedInput) => {
    let input = annotatedInput[0];
    let inputType = annotatedInput[1];
    if (otherNames.length > 0) {
      // Other data is checked before default input types, but
      // one of name/id/labels of the input field has to match exactly!
      let inputNames = readInputNames(input);
      let matching = findIntersection(otherNames, inputNames);
      if (typeof matching !== "undefined") {
        const values = passwordData._other[matching];
        let value = values[values.length - 1];
        if (value == "PASSFF_OMIT_FIELD") {
          return;
        } else if (value == "PASSFF_FIELD_OTP") {
          value = passwordData.otp;
        } else if (value == "PASSFF_FIELD_LOGIN") {
          value = passwordData.login;
        } else if (value == "PASSFF_FIELD_PASSWORD") {
          value = passwordData.password;
        }
        writeValueWithEvents(input, value);
        return;
      }
    }
    if (inputType != "") {
      let pd = passwordData[inputType];
      if (
        pd != "PASSFF_OMIT_FIELD" &&
        (inputType != "otp" || (pd && !otpFilled))
      ) {
        writeValueWithEvents(input, pd);
      }
    }
  });
}

// %%%%%%%%%%%%%%% Implementation of the native-style input dropdown %%%%%%%%%%%

function getPassffIcon() {
  return browser.runtime.getURL("/skin/icon.svg");
}

let popupTarget = null;
let popupDropdown = null;

function closeDropdown() {
  if (popupDropdown && popupDropdown.parentNode) {
    popupDropdown.parentNode.removeChild(popupDropdown);
  }
  popupDropdown = null;
  popupTarget = null;
  document.removeEventListener("click", onOutsideClick, true);
  window.removeEventListener("scroll", closeDropdown, true);
  window.removeEventListener("resize", closeDropdown, true);
}

function onOutsideClick(e) {
  if (popupDropdown && popupDropdown.contains(e.target)) return;
  if (e.target === popupTarget) return;
  closeDropdown();
}

function attachDropdownTrigger(input, inputType) {
  if (typeof input.passffInjected !== "undefined") return;
  log.debug("Attach dropdown trigger", input.id || input.name);
  input.passffInjected = true;
  let handler = () => openInputDropdown(input, inputType);
  input.addEventListener("focus", handler);
  input.addEventListener("click", handler);
}

async function collectDropdownEntries() {
  let entries = [];
  for (const item of matchItems
    .filter((i) => i.isLeaf || i.hasFields)
    .slice(0, 6)) {
    let passwordData = await PassFF.Pass.getPasswordData(item);
    if (typeof passwordData === "undefined") continue;
    entries.push({ item: item, login: passwordData.login });
  }
  return entries;
}

async function openInputDropdown(target, inputType) {
  if (!PassFF.Preferences.markFillable) return;
  if (popupTarget === target) return; // already open for this field

  let url = window.location.href;
  let urlInBlacklist = PassFF.Preferences.markFillableBlacklist.findIndex(
    (str) => url.indexOf(str) >= 0,
  );

  let entries = urlInBlacklist >= 0 ? [] : await collectDropdownEntries();
  let offerGenerate =
    urlInBlacklist < 0 && entries.length === 0 && inputType === "password";

  // focus may have moved on to a different field while awaiting the above;
  // whatever was open for the previously-focused field is stale either way
  if (getActiveElement() !== target) return;
  closeDropdown();

  if (entries.length === 0 && !offerGenerate) return; // nothing to offer
  popupTarget = target;

  let dropdown = document.createElement("div");
  dropdown.id = "passff_input_dropdown";

  if (offerGenerate) {
    let row = document.createElement("button");
    row.type = "button";
    row.classList.add("passff_input_dropdown_entry");
    row.innerHTML = `
      <span class="passff_input_dropdown_entry_icon"></span>
      <span class="passff_input_dropdown_entry_text">
        <span class="passff_input_dropdown_entry_primary"></span>
      </span>
    `;
    row.querySelector(
      ".passff_input_dropdown_entry_icon",
    ).style.backgroundImage =
      "url('" + browser.runtime.getURL("/skin/key.svg") + "')";
    row.querySelector(".passff_input_dropdown_entry_primary").textContent = _(
      "passff_dropdown_generate_password",
    );
    row.addEventListener("click", () => {
      closeDropdown();
      PassFF.Pass.newPasswordUI();
    });
    dropdown.appendChild(row);
  } else {
    let iconUrl = browser.runtime.getURL(
      `/skin/${inputType === "password" ? "globe" : "clock"}.svg`,
    );
    entries.forEach((entry) => {
      let row = document.createElement("button");
      row.type = "button";
      row.classList.add("passff_input_dropdown_entry");
      row.passffItem = entry.item;
      row.innerHTML = `
        <span class="passff_input_dropdown_entry_icon"></span>
        <span class="passff_input_dropdown_entry_text">
          <span class="passff_input_dropdown_entry_primary"></span>
        </span>
      `;
      row.querySelector(
        ".passff_input_dropdown_entry_icon",
      ).style.backgroundImage = "url('" + iconUrl + "')";
      row.querySelector(".passff_input_dropdown_entry_primary").textContent =
        entry.login || entry.item.fullKey.replace(/^\//, "");
      if (inputType === "password") {
        let secondary = document.createElement("span");
        secondary.classList.add("passff_input_dropdown_entry_secondary");
        secondary.textContent = _("passff_dropdown_from_this_site");
        row
          .querySelector(".passff_input_dropdown_entry_text")
          .appendChild(secondary);
      }
      row.addEventListener("click", () => onDropdownEntryClick(entry.item));
      dropdown.appendChild(row);
    });

    if (inputType === "password") {
      let divider = document.createElement("div");
      divider.classList.add("passff_input_dropdown_divider");
      dropdown.appendChild(divider);

      let manage = document.createElement("button");
      manage.type = "button";
      manage.classList.add("passff_input_dropdown_footer");
      manage.textContent = _("passff_dropdown_manage_passwords");
      manage.addEventListener("click", () => {
        closeDropdown();
        PassFF.Preferences.openPreferences();
      });
      dropdown.appendChild(manage);
    }
  }

  document.body.appendChild(dropdown);
  popupDropdown = dropdown;
  positionDropdown(dropdown, target);

  setTimeout(() => {
    document.addEventListener("click", onOutsideClick, true);
    window.addEventListener("scroll", closeDropdown, true);
    window.addEventListener("resize", closeDropdown, true);
  }, 0);
}

function positionDropdown(dropdown, target) {
  // `!important` is required here: the root rule's `all: initial !important`
  // (needed to isolate from host-page CSS) would otherwise beat a plain,
  // non-important inline style for these same properties, leaving the
  // dropdown at its static position (end of <body>) instead of anchored to
  // the field.
  let rect = target.getBoundingClientRect();
  dropdown.style.setProperty("top", rect.bottom + 2 + "px", "important");
  dropdown.style.setProperty("left", rect.left + "px", "important");
  dropdown.style.setProperty("width", rect.width + "px", "important");

  let z = Math.max(
    1,
    ...[...document.querySelectorAll("body *")]
      .filter((e) => ["static", ""].indexOf(e) === -1)
      .map((e) => parseInt(window.getComputedStyle(e).zIndex, 10))
      .filter((e) => e > 0),
  );
  dropdown.style.setProperty("z-index", "" + z, "important");
}

function onDropdownEntryClick(item) {
  let target = popupTarget;
  closeDropdown();
  target.focus();
  PassFF.Pass.getPasswordData(item).then((passwordData) => {
    if (typeof passwordData === "undefined") return;
    return PassFF.Page.fillActiveElement(passwordData).then(() => {
      if (PassFF.Preferences.submitFillable) {
        PassFF.Page.submit(target.form);
      }
    });
  });
}

/* #############################################################################
 * #############################################################################
 *  Helper to prevent auto-fill from causing submit loops
 * #############################################################################
 */

let submittedTabs = {
  _tabs: [],
  get: function (tab) {
    let val = this._tabs.find((val) => {
      // Only check tab id (not url since it might change)
      return val[0] == tab.id;
    });
    if (typeof val !== "undefined") {
      return Date.now() - val[1] < 20000;
    }
    return false;
  },
  set: function (tab, date) {
    this._tabs.unshift([tab.id, date]);
    // Remember only last 10 entries
    this._tabs.splice(10, this._tabs.length);
  },

  unset: function (tab, date) {
    let index = this._tabs.findIndex((t) => {
      return t[0] == tab.id && t[1] == date;
    });
    if (index >= 0) {
      this._tabs.splice(index, 1);
    }
  },
};

/* #############################################################################
 * #############################################################################
 *  Helper for tab initialization
 * #############################################################################
 */

function initTab(tab) {
  return new Promise((resolve, reject) => {
    let onFinally = function () {
      log.debug("initTab: done", tab.id, tab.url, tab.cookieStoreId);
      resolve(tab);
    };
    /*
      On privileged pages, script exec. will be rejected. We resolve anyhow in
      those cases using the same callback for resolve and reject (as long as
      `Promise.prototype.finally()` is not available).
    */
    browser.tabs
      .executeScript(tab.id, {
        code: "PassFF.init();",
        runAt: "document_start",
      })
      .then(onFinally, onFinally);
  });
}

function resetMatchItems() {
  let url = window.location.href;
  matchItems = PassFF.Pass.getUrlMatchingItems(url, tabContainer);
  bestFitItem = PassFF.Pass.findBestFitItem(matchItems, url, tabContainer);
}

function onWindowLoad() {
  resetMatchItems();

  let obs = new MutationObserver(util.debouncedFunction(onNodeAdded, 200));
  obs.observe(document, { attributes: true, childList: true, subtree: true });
  onNodeAdded();

  return PassFF.Page.goToAutoFillPending().then(function (pending) {
    if (pending !== null) {
      PassFF.Page.resolveGoToAutoFillPending(true);
    } else {
      PassFF.Page.autoFill();
    }
  });
}

/* #############################################################################
 * #############################################################################
 *  Implementation of the 'ask to save password' feature
 * #############################################################################
 */

/*
  Heuristic used to avoid ever offering to save credentials from a failed
  login attempt: if the page never navigated away from the URL the form was
  submitted from *and* a password field is still visible on it, this looks
  like a login page re-rendering an error rather than a successful login.
*/
export function loginLikelySucceeded(
  currentUrl,
  originUrl,
  stillShowsPasswordField,
) {
  let sameUrl = currentUrl.split("#")[0] === originUrl.split("#")[0];
  return !(sameUrl && stillShowsPasswordField);
}

function onFormSubmit(e) {
  if (!PassFF.Preferences.askToSavePasswords) return;

  let form = e.target;
  if (!(form instanceof HTMLFormElement)) return;

  // Read values synchronously: once the default submit action proceeds, the
  // form (and possibly the whole document) may be gone.
  let loginInput = inputElements.find(
    (inp) => inp[1] == "login" && inp[0].form === form && inp[0].value != "",
  );
  let passwordInput = inputElements.find(
    (inp) => inp[1] == "password" && inp[0].form === form && inp[0].value != "",
  );
  if (!loginInput || !passwordInput) return;

  PassFF.Pass.maybeOfferSavePassword({
    login: loginInput[0].value,
    password: passwordInput[0].value,
    url: window.location.href,
  });
}

/* #############################################################################
 * #############################################################################
 *  Security Checks for (Auto)fill
 * #############################################################################
 */

export function doAllSecurityChecks(passItemURL, currTabURL) {
  let checkResults = {
    errMessage: null,
    currUrl: currTabURL,
    currUrlValid: false,
    passUrl: passItemURL,
    passUrlValid: false,
    protocol: false,
    fullurl: false,
    subdomain: false,
    domain: false,
  };

  let currURL;
  try {
    currURL = new URL(currTabURL);
    checkResults["currUrlValid"] = true;
  } catch (e) {
    checkResults["errMessage"] = e.message;
    return checkResults;
  }

  if (currURL.protocol == "https:") {
    checkResults["protocol"] = true;
  }

  let errMessage;
  let passURL = [];
  for (const url of passItemURL) {
    try {
      passURL.push(new URL(url));
      checkResults["passUrlValid"] = true;
    } catch (e) {
      errMessage = e.message;
    }
  }

  if (passURL.length == 0) {
    checkResults["errMessage"] = errMessage;
    return checkResults;
  }

  if (passURL.some((url) => url.href == currURL.href)) {
    checkResults["fullurl"] = true;
    checkResults["subdomain"] = true;
    checkResults["domain"] = true;
  } else {
    let currHost = currURL.hostname;
    let passHosts = passURL.map((url) => url.hostname);
    if (passHosts.some((host) => util.checkIsSubdomain(currHost, host))) {
      checkResults["subdomain"] = true;
      checkResults["domain"] = true;
    } else {
      let currDomain = util.getMainDomain(currHost);
      let passDomains = passHosts.map(util.getMainDomain);
      checkResults["domain"] = passDomains.some(
        (domain) => domain == currDomain,
      );
    }
  }

  return checkResults;
}

function securityChecksConfirmationRequired(results) {
  let confirmationMessage = "";
  if (!results["currUrlValid"]) {
    if (
      PassFF.Preferences.checkProtocol == 2 ||
      PassFF.Preferences.checkSubdomain == 2 ||
      PassFF.Preferences.checkDomain == 2 ||
      PassFF.Preferences.checkFullUrl == 2
    ) {
      return ["", false];
    }
    confirmationMessage += _("passff_checks_invalid_url_curr") + " ";
  } else {
    let pref = PassFF.Preferences.checkProtocol;
    if (!results["protocol"] && pref > 0) {
      confirmationMessage += _("passff_checks_protocol") + " ";
      if (pref == 2) return ["", false];
    } else if (
      PassFF.Preferences.checkSubdomain == 0 &&
      PassFF.Preferences.checkDomain == 0 &&
      PassFF.Preferences.checkFullUrl == 0
    ) {
      return ["", true];
    }

    if (!results["passUrlValid"]) {
      if (
        PassFF.Preferences.checkSubdomain == 2 ||
        PassFF.Preferences.checkDomain == 2 ||
        PassFF.Preferences.checkFullUrl == 2
      ) {
        return ["", false];
      }
      confirmationMessage += _("passff_checks_invalid_url_pass") + " ";
    } else {
      let checkLevels = ["fullurl", "subdomain", "domain"];
      let checkLevelPrefs = ["checkFullUrl", "checkSubdomain", "checkDomain"];
      for (let i = 0; i < checkLevels.length; i++) {
        let pref = PassFF.Preferences[checkLevelPrefs[i]];
        if (!results[checkLevels[i]] && pref > 0) {
          confirmationMessage += _(`passff_checks_${checkLevels[i]}`) + " ";
          if (pref == 2) return ["", false];
          break;
        }
      }
    }
  }
  return [confirmationMessage, true];
}

function securityChecks(passItemURL, currTabURL, isAutoFill) {
  if (
    (!isAutoFill && PassFF.Preferences.checkOnlyAuto) ||
    (PassFF.Preferences.checkProtocol == 0 &&
      PassFF.Preferences.checkSubdomain == 0 &&
      PassFF.Preferences.checkDomain == 0 &&
      PassFF.Preferences.checkFullUrl == 0)
  ) {
    return Promise.resolve(true);
  }

  let results = doAllSecurityChecks(passItemURL, currTabURL);
  let [confirmationMessage, alternative] =
    securityChecksConfirmationRequired(results);

  if (confirmationMessage === "") {
    return Promise.resolve(alternative);
  }

  return PassFF.Page.confirm(
    `**${confirmationMessage}**\n${_("passff_checks_url_curr")}` +
      `\`\`\`${results["currUrl"]}\`\`\`${_("passff_checks_url_pass")}` +
      `\`\`\`${results["passUrl"].join("\n")}\`\`\`` +
      `**${_("passff_checks_override_confirm")}**`,
  );
}

/* #############################################################################
 * #############################################################################
 *  Main interface
 * #############################################################################
 */

export default {
  init: function () {
    document.addEventListener("submit", onFormSubmit, true);

    return PassFF.Page.getTabContainer()
      .then((name) => {
        tabContainer = name;

        if (document.readyState === "complete") onWindowLoad();
        else window.addEventListener("load", onWindowLoad);

        /*
          Allow our browser command to bypass the usual DOM event mapping, so that
          the keyboard shortcut still works, even when a password field is focused.
        */
        return PassFF.Preferences.getKeyboardShortcut();
      })
      .then((shortcut) => {
        /*
          Attach a DOM-level event handler for our command key, so it works
          even if an input box is focused.
        */
        document.addEventListener(
          "keydown",
          function (evt) {
            if (shortcut.commandLetter !== evt.key.toLowerCase()) return;

            for (let modifier of Object.keys(shortcut.expectedModifierState)) {
              if (
                shortcut.expectedModifierState[modifier] !==
                evt.getModifierState(modifier)
              ) {
                return;
              }
            }

            /*
            This is a bit of a hack: if we focus the body on keydown,
            the DOM won't let the input box handle the keypress, and
            it'll get routed to _execute_browser_action instead.
          */
            lastActiveElement = getActiveElement();
            document.firstElementChild.focus();
          },
          true,
        );
      });
  },

  initTab: util.backgroundFunction("Page.initTab", function (tab) {
    /*
      We keep track of which tabs have already been initialized to avoid
      unnecessary calls to `browser.tabs.executeScript()`.
    */
    let pendingId = tabInitPending.findIndex(function (t) {
      return t.id == tab.id;
    });
    if (pendingId >= 0) {
      return tabInitPending[pendingId].promise;
    } else {
      pendingId = tabInitPending.length;
      log.debug("initTab: await", tab.id, tab.url);
      let pendingPromise = initTab(tab);
      tabInitPending.push({ id: tab.id, promise: pendingPromise });
      return pendingPromise.then((readyTab) => {
        tabInitPending.splice(pendingId, 1);
        return readyTab;
      });
    }
  }),

  refresh: util.contentFunction("Page.refresh", function () {
    resetMatchItems();
    closeDropdown();
  }),

  // %%%%%%%%%%%%%%%%%%%%%%%%%% URL changer %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

  goToItemUrl: util.backgroundFunction(
    "Page.goToItemUrl",
    function (item, newTab, autoFill, submit) {
      if (!item) return Promise.resolve();
      let promisedTab = newTab ? browser.tabs.create({}) : util.getActiveTab();
      return PassFF.Pass.getPasswordData(item)
        .then((passwordData) => {
          if (typeof passwordData === "undefined") return null;
          log.debug("goToItemUrl:", item.fullKey, newTab, autoFill, submit);
          let url = passwordData.url[0];
          for (let i = 0; i < passwordData.url.length; i++) {
            try {
              url = new URL(passwordData.url[i]).href;
            } catch (e) {
              continue;
            }
          }
          log.debug(`goToItemUrl: using URL ${url}`);
          return promisedTab.then((tab) => {
            let tabUrl = tab.url.replace(/^https?:\/+/, "").replace(/\/+$/, "");
            let testUrl = url.replace(/^https?:\/+/, "").replace(/\/+$/, "");
            if (tabUrl === testUrl) {
              if (autoFill) PassFF.Page.fillInputs(tab, item, submit);
              return null;
            } else {
              return browser.tabs.update(tab.id, { url: url });
            }
          });
        })
        .then(function (tab) {
          if (tab !== null && autoFill) {
            goToAutoFillPending = {
              tab: tab,
              submit: submit,
              item: item,
            };
          }
        });
    },
  ),

  goToAutoFillPending: util.backgroundFunction(
    "Page.goToAutoFillPending",
    () => goToAutoFillPending,
  ),

  resolveGoToAutoFillPending: util.backgroundFunction(
    "Page.resolveGoToAutoFillPending",
    function (fillInputs) {
      log.debug("Resolving pending auto fill", fillInputs);
      if (fillInputs === true) {
        let pending = goToAutoFillPending;
        PassFF.Page.fillInputs(pending.tab, pending.item, pending.submit);
      }
      goToAutoFillPending = null;
    },
  ),

  // %%%%%%%%%%%%%%%%%%%%%%%%%% Form filler %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

  autoFill: util.contentFunction("Page.autoFill", function () {
    if (!PassFF.Preferences.autoFill) return;

    let url = window.location.href;
    let urlInBlacklist = PassFF.Preferences.autoFillBlacklist.findIndex(
      (str) => {
        return url.indexOf(str) >= 0;
      },
    );
    if (urlInBlacklist >= 0) return;

    log.debug("Start pref-auto-fill");
    if (bestFitItem) {
      PassFF.Page.fillInputs(bestFitItem, false, true).then((passwordData) => {
        if (
          PassFF.Preferences.autoSubmit &&
          PassFF.Pass.getItemsLeafs(matchItems).length == 1 &&
          passwordData._other["autosubmit"] !== "false"
        ) {
          PassFF.Page.safeSubmit();
        }
      });
    }
  }),

  fillActiveElement: util.contentFunction(
    "Page.fillActiveElement",
    function (passwordData) {
      let activeElement = getActiveElement();
      let inputTypes = loginInputTypes.concat(["password", "number"]);
      log.debug("Fill active element", activeElement);
      if (
        activeElement.tagName !== "INPUT" ||
        inputTypes.indexOf(activeElement.type) < 0
      )
        return;
      return securityChecks(passwordData.url, window.location.href, false).then(
        (result) => {
          if (!result) return;
          let inputs = [activeElement];
          if (activeElement.form) {
            inputs = Array.from(activeElement.form.elements).filter(
              (el) => el.tagName == "INPUT",
            );
          }
          inputs = annotateInputs(
            Array.from(inputs).filter(isVisible).filter(isWritable),
          );
          setInputs(inputs, passwordData);
        },
      );
    },
  ),

  fillInputs: util.contentFunction(
    "Page.fillInputs",
    function (item, andSubmit, isAutoFill) {
      refocus();
      if (
        inputElements.filter((inp) => inp[1] == "password" || inp[1] == "otp")
          .length === 0
      ) {
        if (inputElements.length == 0 || isAutoFill) {
          log.debug("fillInputs: No relevant login input elements recognized.");
          return Promise.resolve();
        } else {
          log.debug("fillInputs: Warning: no password inputs found!");
        }
      }
      return PassFF.Pass.getPasswordData(item).then((passwordData) => {
        if (typeof passwordData === "undefined") return;
        log.debug("fillInputs: Start auto-fill using", item.fullKey, andSubmit);
        return securityChecks(
          passwordData.url,
          window.location.href,
          isAutoFill,
        ).then((result) => {
          if (!result) return;
          setInputs(inputElements, passwordData);
          if (andSubmit) {
            PassFF.Page.submit();
          } else {
            refocus();
          }
          return passwordData;
        });
      });
    },
    true,
  ),

  // %%%%%%%%%%%%%%%%%%%%%%% Form submitter %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

  submit: util.contentFunction(
    "Page.submit",
    function (form) {
      if (typeof form === "undefined") {
        let passwords = inputElements.filter((inp) => inp[1] == "password");
        if (passwords.length === 0) return false;
        form = passwords[0][0].form;
      }

      if (!form) return false;
      let submitBtn = getSubmitButton(form);
      log.debug("Unsafe submit...", submitBtn);
      if (submitBtn) {
        submitBtn.click();
      } else {
        form.requestSubmit();
      }
      return true;
    },
    true,
  ),

  safeSubmit: util.backgroundFunction(
    "Page.safeSubmit",
    function (sender) {
      let tab = sender.tab;
      if (submittedTabs.get(tab)) {
        log.debug("safeSubmit: Tab already auto-submitted. skip it");
        return;
      }
      log.debug("safeSubmit: Starting submit");
      let date = Date.now();
      submittedTabs.set(tab, date);
      PassFF.Page.submit(tab).then((results) => {
        if (!results || results[0] !== true) {
          submittedTabs.unset(tab, date);
        }
      });
    },
    true,
  ),

  // %%%%%%%%%%%%%%% Implementation of notification dialog %%%%%%%%%%%%%%%%%%%%%%%

  notify: util.contentFunction("Page.notify", function (message) {
    let dialog = document.getElementById("passff_notification");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "passff_notification";
      document.body.appendChild(dialog);
    }
    dialog.innerHTML = "<div><p></p><div><button>OK</button></div></div>";
    let div = dialog.querySelector("div");
    div.style.backgroundImage = "url('" + getPassffIcon() + "')";
    let dialogText = null;
    dialogText = dialog.querySelector("div p");
    dialogText.textContent = message; // prevent HTML injection
    util.parseMarkdown(dialogText);
    dialog.showModal();
    return new Promise(function (resolve, reject) {
      let button = dialog.querySelector("button");
      button.addEventListener("click", () => {
        dialog.close();
        document.body.removeChild(dialog);
        resolve(true);
      });
    });
  }),

  confirm: util.contentFunction("Page.confirm", function (message) {
    let dialog = document.getElementById("passff_notification");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "passff_notification";
      document.body.appendChild(dialog);
    }
    dialog.innerHTML =
      "<div><p></p><div><button>OK</button> <button>Cancel</button></div></div>";
    let div = dialog.querySelector("div");
    div.style.backgroundImage = "url('" + getPassffIcon() + "')";
    let dialogText = null;
    dialogText = dialog.querySelector("div p");
    dialogText.textContent = message; // prevent HTML injection
    util.parseMarkdown(dialogText);
    dialog.showModal();
    return new Promise(function (resolve, reject) {
      let button = dialog.querySelector("button:first-child");
      button.addEventListener("click", () => {
        dialog.close();
        document.body.removeChild(dialog);
        resolve(true);
      });
      button = dialog.querySelector("button:last-child");
      button.addEventListener("click", () => {
        dialog.close();
        document.body.removeChild(dialog);
        resolve(false);
      });
    });
  }),

  // %%%%%%%%%%%%%%% Implementation of 'ask to save password' feature %%%%%%%%%%%%%

  // A short settle delay lets pages that show a login error via AJAX
  // (without a full navigation) do so before `loginLikelySucceeded` runs.
  checkLoginLikelySucceeded: util.contentFunction(
    "Page.checkLoginLikelySucceeded",
    function (originUrl) {
      return new Promise((resolve) => {
        setTimeout(() => {
          let stillShowsPasswordField = querySelectorAllShadows("input")
            .filter(isVisible)
            .some((el) => el.type === "password");
          resolve(
            loginLikelySucceeded(
              window.location.href,
              originUrl,
              stillShowsPasswordField,
            ),
          );
        }, 700);
      });
    },
    true,
  ),

  showSavePasswordPrompt: util.contentFunction(
    "Page.showSavePasswordPrompt",
    function (details) {
      let old = document.getElementById("passff_save_prompt");
      if (old) old.parentNode.removeChild(old);

      let panel = document.createElement("div");
      panel.id = "passff_save_prompt";
      panel.innerHTML = `
        <p class="passff_save_prompt_header"></p>
        <label class="passff_save_prompt_label"></label>
        <input type="text" class="passff_save_prompt_username" autocomplete="off" />
        <label class="passff_save_prompt_label"></label>
        <div class="passff_save_prompt_password_row">
          <input type="password" class="passff_save_prompt_password" autocomplete="off" />
          <button type="button" class="passff_save_prompt_eye"></button>
        </div>
        <div class="passff_save_prompt_extra_fields"></div>
        <button type="button" class="passff_save_prompt_add_field"></button>
        <div class="passff_save_prompt_footer">
          <div class="passff_save_prompt_notnow_group">
            <button type="button" class="passff_save_prompt_notnow"></button>
            <button type="button" class="passff_save_prompt_chevron">&#9662;</button>
            <div class="passff_save_prompt_menu">
              <button type="button" class="passff_save_prompt_never"></button>
            </div>
          </div>
          <button type="button" class="passff_save_prompt_save"></button>
        </div>
      `;

      panel.querySelector(".passff_save_prompt_header").textContent = _(
        details.mode === "update"
          ? "passff_savepassword_title_update"
          : "passff_savepassword_title_new",
        [details.host],
      );

      let labels = panel.querySelectorAll(".passff_save_prompt_label");
      labels[0].textContent = _("passff_savepassword_username_label");
      labels[1].textContent = _("passff_savepassword_password_label");

      let usernameInput = panel.querySelector(".passff_save_prompt_username");
      usernameInput.value = details.login; // .value, never innerHTML

      let passwordInput = panel.querySelector(".passff_save_prompt_password");
      passwordInput.value = details.password; // .value, never innerHTML

      let eyeButton = panel.querySelector(".passff_save_prompt_eye");
      eyeButton.title = _("passff_savepassword_toggle_password");
      eyeButton.style.backgroundImage =
        "url('" + browser.runtime.getURL("/skin/eye.svg") + "')";
      eyeButton.addEventListener("click", () => {
        let showing = passwordInput.type === "text";
        passwordInput.type = showing ? "password" : "text";
        eyeButton.classList.toggle("passff_save_prompt_eye_open", !showing);
      });

      let extraFieldsContainer = panel.querySelector(
        ".passff_save_prompt_extra_fields",
      );
      let addFieldButton = panel.querySelector(".passff_save_prompt_add_field");
      addFieldButton.textContent = _("passff_savepassword_add_field_button");

      function addExtraFieldRow() {
        let row = document.createElement("div");
        row.classList.add("passff_save_prompt_extra_field_row");
        row.innerHTML = `
          <input type="text" class="passff_save_prompt_extra_field_name" autocomplete="off" />
          <input type="text" class="passff_save_prompt_extra_field_value" autocomplete="off" />
          <button type="button" class="passff_save_prompt_extra_field_remove">&times;</button>
        `;
        let nameInput = row.querySelector(
          ".passff_save_prompt_extra_field_name",
        );
        nameInput.placeholder = _("passff_savepassword_field_name_placeholder");
        row.querySelector(".passff_save_prompt_extra_field_value").placeholder =
          _("passff_savepassword_field_value_placeholder");
        row
          .querySelector(".passff_save_prompt_extra_field_remove")
          .addEventListener("click", () => row.remove());
        extraFieldsContainer.appendChild(row);
        nameInput.focus();
      }

      addFieldButton.addEventListener("click", addExtraFieldRow);

      let notNowButton = panel.querySelector(".passff_save_prompt_notnow");
      notNowButton.textContent = _("passff_savepassword_not_now_button");
      let chevronButton = panel.querySelector(".passff_save_prompt_chevron");
      let menu = panel.querySelector(".passff_save_prompt_menu");
      let neverButton = panel.querySelector(".passff_save_prompt_never");
      neverButton.textContent = _("passff_savepassword_never_button");
      let saveButton = panel.querySelector(".passff_save_prompt_save");
      saveButton.textContent = _("passff_savepassword_save_button");

      chevronButton.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.style.display = menu.style.display === "block" ? "none" : "block";
      });

      document.body.appendChild(panel);

      return new Promise((resolve) => {
        let resolved = false;
        let onOutsideClick = (e) => {
          if (!panel.contains(e.target)) finish("notNow");
        };
        let finish = (action) => {
          if (resolved) return;
          resolved = true;
          document.removeEventListener("click", onOutsideClick, true);
          if (panel.parentNode) panel.parentNode.removeChild(panel);
          let extraFields = Array.from(
            extraFieldsContainer.querySelectorAll(
              ".passff_save_prompt_extra_field_row",
            ),
          )
            .map((row) => ({
              name: row
                .querySelector(".passff_save_prompt_extra_field_name")
                .value.trim(),
              value: row.querySelector(".passff_save_prompt_extra_field_value")
                .value,
            }))
            .filter((field) => field.name.length > 0);
          resolve({
            action: action,
            login: usernameInput.value,
            password: passwordInput.value,
            extraFields: extraFields,
          });
        };

        // deferred so the click that triggered this panel (e.g. a submit
        // button) doesn't immediately count as an "outside" click
        setTimeout(
          () => document.addEventListener("click", onOutsideClick, true),
          0,
        );

        notNowButton.addEventListener("click", () => finish("notNow"));
        neverButton.addEventListener("click", () => finish("never"));
        saveButton.addEventListener("click", () => finish("save"));
      });
    },
    true,
  ),

  // %%%%%%%%%%%%%%%%%%%%%%%%%%% Miscellaneous %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

  getActiveInput: util.contentFunction("Page.getActiveInput", function () {
    let input = getActiveElement();
    if (input.tagName != "INPUT" || loginInputTypes.indexOf(input.type) < 0) {
      return null;
    }
    return [input.type, input.name ? input.name : input.id];
  }),

  readLoginInput: util.contentFunction("Page.readLoginInput", function () {
    let login = "";
    inputElements
      .filter((inp) => inp[1] == "login" && inp[0].value != "")
      .forEach((inp) => {
        login = inp[0].value;
      });
    return login;
  }),

  getTabContainer: util.backgroundFunction(
    "Page.getTabContainer",
    function (sender) {
      return util.getTabContainer(sender.tab);
    },
    true,
  ),
};
