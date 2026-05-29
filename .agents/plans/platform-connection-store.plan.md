Currently each tenant require their connection details in tenant record. In some cases we'll want to reuse platform connection (gitlab bot, github app) for tenants. For this:

1. Store schema updates (both flotiq and sqlite) to new schema version
   1. Create platform connection store with id, name (unique, for in-cli identification), platform name, created at, updated at and platformConnectionJson fields
   2. Add connection id column to tenant store
   3. For existing gitlab tenants in sqlite extract base url, api token, bot username, bot id and migrate them into new connections based on sluggified baseurl. Leave project id and webhook secret as tenant-level connections. This must happen on sqlite migration level. Loose sluggification rule: `https://abc.zxc.com` becomes `abc-zxc`, `https://dsa-qwe.lol.pl` becomes `dsa-qwe-lol`. During migration we can scan for url->slug pairs and if there are conflicts (e.g. both `https://abc.zxc.com` and `https://abc.zxc.pl` are present as base urls), then we add numeric extension to the new connection name (`https://abc.zxc.com` becomes `abc-zxc`, then next tenant has `https://abc.zxc.pl` base url and it becomes name=`abc-zxc-1`). On paper this conflict reolution will not be needed as project is not yet widely used, so we treat it only as just-in-case protection.
   4. For flotiq no migrations are required - fold schema updates so that existing migration already has new shape in it. Pay attention to relation field use and order of ctd creation.
2. Rename `getRegistrationSchema` to `getTenantRegistrationSchema` and introduce separate `getConnectionRegistrationSchema`
3. Update CLI so that:
   1. tenant add requires connection name (it must be for the same platform as platform connection)
   2. there are separate add/update/remove commands for platform-connection
   3. platforms provide separate zodSchema for params used during platform-connection add/update commands via `getRegistrationSchema`
4. Update docs & Readme so that new commands are described and platform connection registration is described as mandatory step when new connection credentials are used.