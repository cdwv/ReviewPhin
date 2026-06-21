// @ts-check
/** @typedef {import("../../../../src/platforms/github/setup-page.js").GitHubSetupPageData} GitHubSetupPageData */
/** @typedef {Extract<GitHubSetupPageData, { page: "register" }>} RegisterSetupPageData */
/** @typedef {Extract<GitHubSetupPageData, { page: "installation" }>} InstallationSetupPageData */
/** @typedef {Extract<GitHubSetupPageData, { page: "success" }>} SuccessSetupPageData */
/** @typedef {Extract<GitHubSetupPageData, { page: "error" }>} ErrorSetupPageData */

(function () {
  const dataElement = document.getElementById("reviewphin-setup-data");
  if (!dataElement) {
    return;
  }

  /** @type {GitHubSetupPageData} */
  const data = JSON.parse(dataElement.textContent || "{}");

  /**
   * @param {string} selector
   * @returns {HTMLElement}
   */
  function requireElement(selector) {
    /**
     * @type {HTMLElement | null}
     */
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error("Missing setup page element: " + selector);
    }
    return element;
  }

  /**
   * @param {string} selector
   * @param {unknown} value
   */
  function setText(selector, value) {
    requireElement(selector).textContent = String(value);
  }

  /** @param {RegisterSetupPageData} page */
  function renderRegister(page) {
    const form = /** @type {HTMLFormElement} */ (requireElement("#setup-form"));
    const ownerType = /** @type {HTMLSelectElement} */ (
      requireElement("#owner-type")
    );
    const appName = /** @type {HTMLInputElement} */ (
      requireElement("#app-name")
    );
    const description = /** @type {HTMLTextAreaElement} */ (
      requireElement("#description")
    );
    const manifestInput = /** @type {HTMLInputElement} */ (
      requireElement("#manifest-input")
    );
    const preview = requireElement("#manifest-preview");
    const webhookUrl = /** @type {HTMLInputElement} */ (
      requireElement("#webhook-url")
    );
    const iconUrl = /** @type {HTMLInputElement} */ (
      requireElement("#icon-url")
    );
    const error = requireElement('[data-field="error"]');

    setText('[data-field="owner"]', page.owner);
    appName.value = "ReviewPhin " + page.owner;
    description.value = "ReviewPhin code review automation for " + page.owner;
    error.textContent = page.error || "";
    error.hidden = !page.error;

    function update() {
      const encodedToken = encodeURIComponent(page.setupToken);
      const returnUrl =
        page.publicUrl + "/setup/github/" + encodedToken + "/return";
      const setupUrl =
        page.publicUrl + "/setup/github/" + encodedToken + "/installed";
      const manifest = {
        name: appName.value,
        url: page.publicUrl,
        description: description.value,
        hook_attributes: {
          url: page.publicUrl + "/webhooks/github",
          active: true,
        },
        redirect_url: returnUrl,
        setup_url: setupUrl,
        public: false,
        default_permissions: page.permissions,
        default_events: page.events,
      };

      webhookUrl.value = manifest.hook_attributes.url;
      iconUrl.value = page.publicUrl + "/favicon.png";
      manifestInput.value = JSON.stringify(manifest);
      preview.textContent = JSON.stringify(manifest, null, 2);
      form.action =
        ownerType.value === "organization"
          ? "https://github.com/organizations/" +
            encodeURIComponent(page.owner) +
            "/settings/apps/new?state=" +
            encodedToken
          : "https://github.com/settings/apps/new?state=" + encodedToken;
    }

    form.addEventListener("input", update);
    update();
  }

  /** @param {InstallationSetupPageData} page */
  function renderInstallation(page) {
    setText('[data-field="appName"]', page.appName);
    setText('[data-field="owner"]', page.owner);
    const installUrl = /** @type {HTMLAnchorElement} */ (
      requireElement('[data-field="installUrl"]')
    );
    installUrl.href = page.installUrl;
  }

  /** @param {SuccessSetupPageData} page */
  function renderSuccess(page) {
    setText(
      '[data-field="ownerSummary"]',
      page.ownerLogin + " (" + page.ownerType + ")",
    );
    setText('[data-field="appName"]', page.appName);
    setText('[data-field="badgeAppName"]', page.appName);
    setText('[data-field="appSlug"]', page.appSlug);
    setText('[data-field="installationId"]', page.installationId);
    setText(
      '[data-field="repositoryAccess"]',
      page.repositorySelection +
        " (" +
        page.accessibleRepositoryCount +
        " currently accessible)",
    );

    const avatar = /** @type {HTMLImageElement} */ (
      requireElement('[data-field="ownerAvatarUrl"]')
    );
    if (page.ownerAvatarUrl) {
      avatar.src = page.ownerAvatarUrl;
      avatar.hidden = false;
    }

    const appLinkSection = requireElement('[data-section="appHtmlUrl"]');
    const appLink = /** @type {HTMLAnchorElement} */ (
      requireElement('[data-field="appHtmlUrl"]')
    );
    if (page.appHtmlUrl) {
      appLink.href = page.appHtmlUrl;
      appLinkSection.hidden = false;
    }

    const iconLink = /** @type {HTMLAnchorElement} */ (
      requireElement('[data-field="iconUrl"]')
    );
    iconLink.href = page.iconUrl;

    const reviewphinAvatar = /** @type {HTMLImageElement} */ (
      requireElement('[data-field="reviewphinAvatar"]')
    );
    reviewphinAvatar.src = page.iconUrl;

    const settingsLink = /** @type {HTMLAnchorElement} */ (
      requireElement('[data-field="appSettingsUrl"]')
    );
    const encodedSlug = encodeURIComponent(page.appSlug);
    settingsLink.href =
      page.ownerType.toLowerCase() === "organization"
        ? "https://github.com/organizations/" +
          encodeURIComponent(page.ownerLogin) +
          "/settings/apps/" +
          encodedSlug
        : "https://github.com/settings/apps/" + encodedSlug;
  }

  /** @param {ErrorSetupPageData} page */
  function renderError(page) {
    setText('[data-field="message"]', page.message);
  }

  if (data.page === "register") {
    renderRegister(data);
  } else if (data.page === "installation") {
    renderInstallation(data);
  } else if (data.page === "success") {
    renderSuccess(data);
  } else if (data.page === "error") {
    renderError(data);
  }
})();
