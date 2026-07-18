(function () {
  "use strict";

  var SUPPORTED = ["fr", "en"];
  var DEFAULT_LANG = "fr";
  var STORAGE_KEY = "generic-operator-lang";

  function getInitialLang() {
    var stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    if (stored && SUPPORTED.indexOf(stored) !== -1) return stored;
    var nav = (navigator.language || "fr").slice(0, 2);
    return SUPPORTED.indexOf(nav) !== -1 ? nav : DEFAULT_LANG;
  }

  function getByPath(obj, path) {
    return path.split(".").reduce(function (acc, key) {
      return acc && acc[key] !== undefined ? acc[key] : null;
    }, obj);
  }

  function applyTranslations(dict) {
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      var value = getByPath(dict, key);
      if (value !== null) el.textContent = value;
    });

    document.querySelectorAll("[data-i18n-attr]").forEach(function (el) {
      el.getAttribute("data-i18n-attr").split(";").forEach(function (pair) {
        var parts = pair.split(":");
        if (parts.length !== 2) return;
        var attr = parts[0].trim();
        var key = parts[1].trim();
        var value = getByPath(dict, key);
        if (value !== null) el.setAttribute(attr, value);
      });
    });

    document.documentElement.setAttribute("lang", dict.__lang || DEFAULT_LANG);
  }

  function setActiveButton(lang) {
    document.querySelectorAll(".lang-btn").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-lang") === lang);
    });
  }

  function loadLang(lang) {
    fetch("locales/" + lang + ".json")
      .then(function (res) { return res.json(); })
      .then(function (dict) {
        dict.__lang = lang;
        applyTranslations(dict);
        setActiveButton(lang);
        try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
      })
      .catch(function (err) {
        console.error("Failed to load locale:", lang, err);
      });
  }

  document.querySelectorAll(".lang-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      loadLang(btn.getAttribute("data-lang"));
    });
  });

  loadLang(getInitialLang());

  // Best-effort: reflect the latest published tag without needing a site rebuild.
  // Falls back silently to whatever version is already in the HTML if the API is
  // unavailable or rate-limited.
  fetch("https://api.github.com/repos/CCoupel/Generic-Operator/tags")
    .then(function (res) { return res.ok ? res.json() : []; })
    .then(function (tags) {
      if (Array.isArray(tags) && tags.length > 0 && tags[0].name) {
        var badge = document.getElementById("version-badge");
        if (badge) badge.textContent = tags[0].name;
      }
    })
    .catch(function () {});
})();
