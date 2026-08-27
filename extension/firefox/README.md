# Pin to GitHub

This is the Firefox build of the Websim revision backup extension.

## Load temporarily

1. Unzip the downloaded bundle.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on…** and select the extracted `manifest.json`.
4. Open the extension popup and enter a GitHub fine-grained personal access token with **Contents: Read and write**, **Administration: Read and write**, and permission to create repositories.
5. Choose the visibility for the active Websim project/tab and a branch strategy. Saving a changed visibility updates its linked GitHub repository; when no project is open, the value is the default for new repositories.

The extension reuses a saved or discovered repository for each Websim project, using a readable title plus a short project ID suffix when it needs to create one. It stores the token in `browser.storage.local` and calls Websim’s revision/CDN endpoints and GitHub’s Git Data API directly from the browser. If a sync fails, open the popup and use **Copy logs** to copy the sanitized diagnostic trail.
When auto-sync is enabled, opening a project never writes to GitHub. A commit can begin only after Websim has successfully accepted a project update (such as pinning a revision) in that tab; that server-authorized update is the extension's proof that the visitor can edit the project.

For auto-pin troubleshooting, enable **Advanced logs**, clear the logs, reload the Websim tab, pin or switch a version, then use **Copy logs**. The extension watches Websim's successful project update request as a fallback trigger, so this also works when the pin control is rendered inside a Websim component the content script cannot inspect. It compares the pin/version state before and after the request, so metadata-only edits such as description changes are ignored. A successful run includes `pin.candidate.request`, `pin.candidate.response`, `pin.autosync.trigger`, and then GitHub events. The toolbar icon shows a `…` badge and the Websim tab shows a loading toast while the sync is running.
