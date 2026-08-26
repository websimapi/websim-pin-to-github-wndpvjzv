# Pin to GitHub

This is the Firefox build of the Websim revision backup extension.

## Load temporarily

1. Unzip the downloaded bundle.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on…** and select the extracted `manifest.json`.
4. Open the extension popup and enter a GitHub fine-grained personal access token with **Contents: Read and write** and permission to create repositories.
5. Choose private/public repository visibility and a branch strategy. Save, then pin a project in Websim.

The extension reuses a saved or discovered repository for each Websim project, using a readable title plus a short project ID suffix when it needs to create one. It stores the token in `browser.storage.local` and calls Websim’s revision/CDN endpoints and GitHub’s Git Data API directly from the browser. If a sync fails, open the popup and use **Copy logs** to copy the sanitized diagnostic trail.
