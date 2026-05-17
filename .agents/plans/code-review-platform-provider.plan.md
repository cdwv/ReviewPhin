# Goal

Provide unified API for multiple Code Review platforms providers.

**Warning:** The plan in its current state is not ready for automated implementation with Agent.

1. Define common API
2. Wrap GitLab-specific logic into adapter
3. Expand tenant registration to provide CR platform adapter type (or custom js for own implementation later on)
4. Expand CR platform provider api to allow handling webhook requests and host custom pages (e.g. to allow users to setup their integration with that platform)
   - <baseurl>/setup/<providertype>/<tenantid> - potential setup page if user auth/redirect flow needs to start/finish somewhere
5. <baseurl>/webhook/<providertype> - allows us to switch between CR platform providers, and decide how to extract data from it (to be decided how this responsibility switches between provider and app itself, because provider cannot extract any tenant from the db, and yet some provider specific logic will be needed to validate webhooks). This will start review flow if we got an webhook for matching tenant.
6. Wrap necessary changes to CR provider config to tenant table and bump schema to v001. Provide migrations for store providers to migrate data adequately.
