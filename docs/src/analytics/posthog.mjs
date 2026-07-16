const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const POSTHOG_DEFAULTS = "2026-05-30";

function readPostHogConfig(env = process.env) {
  const token = env.REVIEWPHIN_POSTHOG_KEY?.trim();
  if (!token) {
    return undefined;
  }

  return {
    token,
    host: env.REVIEWPHIN_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST,
    uiHost: env.REVIEWPHIN_POSTHOG_UI_HOST?.trim() || undefined,
  };
}

function serializeForScript(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function getPostHogScriptContent(env = process.env) {
  const config = readPostHogConfig(env);
  if (!config) {
    return undefined;
  }

  return `!function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
posthog.init(${serializeForScript(config.token)}, {
  api_host: ${serializeForScript(config.host)},
  ${config.uiHost ? `ui_host: ${serializeForScript(config.uiHost)},` : ""}
  defaults: ${serializeForScript(POSTHOG_DEFAULTS)},
  capture_pageview: true,
  person_profiles: "identified_only",
});`;
}

export function getPostHogHead(env = process.env) {
  const content = getPostHogScriptContent(env);
  return content
    ? [
        {
          tag: "script",
          content,
        },
      ]
    : [];
}
