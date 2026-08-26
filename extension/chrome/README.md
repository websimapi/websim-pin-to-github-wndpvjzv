# Pin to GitHub

This is the Chrome/Chromium build of the Websim revision backup extension.

## Load locally

1. Unzip the downloaded bundle.
2. Open `chrome://extensions` in Chrome, Brave, Arc, or another Chromium browser.
3. Enable **Developer mode**, choose **Load unpacked**, and select this folder.
4. Open the extension popup and enter a GitHub fine-grained personal access token with **Contents: Read and write** and permission to create repositories.
5. Choose private/public repository visibility and a branch strategy. Save, then pin a project in Websim.

The extension reuses a saved or discovered repository for each Websim project, using a readable title plus a short project ID suffix when it needs to create one. It stores the token in `chrome.storage.local` and calls Websim’s revision/CDN endpoints and GitHub’s Git Data API directly from the browser. If a sync fails, open the popup and use **Copy logs** to copy the sanitized diagnostic trail.
