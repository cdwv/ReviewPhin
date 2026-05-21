# Goal

Our flow allows multiple targetted comments at once. Now we need to be able to apply basic grouping logic and coalesce multiple interactions into one review.

1. Interactions for the same merge request should have basic debounce implemented.
2. Multiple hooks in the same interaction debounce window are added to one open job
3. Only after debounce window passes, job closes admission and can start running
4. Jobs that already started at least once can no longer open for webhook admission
5. Default debounce timeout: 15s, resets each time new interaction is admitted into job
6. Once run starts:
   - We assess all triggering comments to get grouped plan. 
   - If at least one job requires review or chatter to start, whole batch is passed through relevant models.
   - Review & chatter must accept properly multiple response targets and react/respond to each
   - Upon admission, all triggering comments should get eyes emoji (including in-thread comments, not only new discussions as it was up to this point). The same on success and fail.