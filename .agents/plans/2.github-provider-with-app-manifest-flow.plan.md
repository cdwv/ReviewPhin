# Goal

**Warning:** The plan in its current state is not ready for automated implementation with Agent.

1. Tenant project is registered in cli for github project. This results in dedicated url generation for setup page.
2. Users to go to generated <baseurl>/setup/github/<tenantid> page to start app manifest flow
3. User enters necessary data, manifest is generated and they can click submit to be sent to github. tenat id is sent as state.
4. On Github user reviews all necessary info (bot username, app name etc) and registers the app
5. GitHub redirects back to <baseurl>/setup/github/<tenantid>. We detect valid "back" url with what params are there. Server validates if given tenant can be still configured and if project name matches. If all is good, final credentials and repo id are saved to tenant config for github. If something goes wrong, we show normal setup page with some error status.
6. Once all is done and webhooks start flowing to the app, we handle webhook data in one central webhook catcher, that uses provider to validate and extract necessary info about PR from webhook. Repo ID is universally used to validate target repo