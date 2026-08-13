# Invalid Remote User API Isolation Design

## Goal

Allow a GitHub remote-source import to continue when one or more downloaded scripts do not contain valid LX user API metadata. Import every valid script, skip invalid scripts, and show one summary dialog after the import.

A network, HTTP, repository metadata, snapshot, or batch-limit failure still aborts the import. These failures can produce an incomplete snapshot, so the application must keep the current local sources.

## Confirmed Behavior

The download stage keeps its current all-or-nothing behavior. A request failure or invalid download response stops the operation before the main process receives an import batch.

The main process validates each downloaded script independently. It records the remote path of every script rejected by `parseScriptInfo` and continues preparing the remaining scripts.

When at least one script is valid, the main process atomically replaces the custom-source state with only the valid scripts. It returns the committed API list and the rejected remote paths to the renderer.

When every script is invalid, the main process raises a dedicated invalid-script error before committing state. The existing local sources, scripts, selected source, fallback sources, and runtime instances remain unchanged.

## Result Contract

Extend the GitHub replacement result returned across IPC. A successful result contains:

- `apiList`: the committed list of valid remote sources;
- `skipped`: the remote paths rejected during script parsing.

An import with no skipped scripts returns an empty `skipped` array. Existing post-commit lifecycle failures continue to carry the retained committed API list through the current error envelope.

The all-invalid failure uses `GITHUB_INVALID_SCRIPT`. Its detail identifies the rejected paths so the existing error formatter can present a useful message without exposing script contents.

## User Interface

After a mixed batch commits, the source-management modal shows the normal success status using the number of imported sources. It then opens one dialog that states how many invalid scripts were skipped and lists their remote paths.

The dialog truncates each path and the combined list to bounded lengths before rendering. It never includes script text or an exception stack.

When every script is invalid, the modal uses the existing error path and shows one invalid-script dialog. It does not show an import-success status or reconcile the local API list.

Add localized summary strings for Simplified Chinese, Traditional Chinese, and English. The strings include placeholders for the skipped count and path list.

## Transaction And Runtime Safety

`prepareApisFromGitHub` builds a complete candidate state in memory. It does not mutate persisted state while parsing scripts. `replaceApisFromGitHub` commits the candidate once, after preparation confirms that at least one valid source exists.

Runtime invalidation, rollback, selected-source reconciliation, fallback cleanup, and source-change notification retain their current behavior. Skipped scripts never receive API IDs, persisted script entries, or runtime instances.

## Testing

Add regression tests before production changes for these cases:

- a mixed batch prepares and commits every valid script while returning all invalid remote paths;
- invalid scripts at different positions do not prevent later valid scripts from being prepared;
- an all-invalid batch rejects before a state commit and preserves the previous source state;
- download, HTTP, snapshot, and limit errors still reject the whole operation;
- the renderer reconciles the committed list, reports the valid-source count, and opens one summary dialog for multiple skipped paths;
- an all-invalid failure follows the existing error dialog path and does not publish a replacement list.

Run the focused user-API test suite, lint each touched source file, and build the renderer and main bundles.

## Non-Goals

- Skipping scripts that could not be downloaded.
- Keeping an older local copy of an invalid remote script.
- Retrying parse failures.
- Changing local file imports, online URL imports, or user API synchronization.
- Running remote scripts during validation beyond the metadata parsing already performed by `parseScriptInfo`.
