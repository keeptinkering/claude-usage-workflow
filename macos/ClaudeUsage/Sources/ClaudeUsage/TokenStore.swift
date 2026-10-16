import Foundation

/// The parts of the stored Claude Code login this app needs.
struct StoredCredentials: Equatable {
    let accessToken: String
    /// Expiry in epoch milliseconds, when the store records one.
    let expiresAt: Double?

    /// True when the token is past (or within a minute of) its expiry. Unknown
    /// expiry counts as not expired; the endpoint's 401 is the backstop.
    var isExpired: Bool {
        guard let expiresAt else { return false }
        return expiresAt - 60_000 <= Date().timeIntervalSince1970 * 1000
    }
}

/// Resolves the Claude Code OAuth access token, same order as the shared core.
///
/// 1. macOS Keychain, via the `security` CLI (avoids SecItem ACL prompts).
/// 2. Fallback file: ~/.claude/.credentials.json.
///
/// Both hold a JSON blob with the token at `.claudeAiOauth.accessToken`. The
/// store is re-read on every call so a token Claude Code refreshed in the
/// meantime is picked up. All calls block, so run them off the main actor.
enum TokenStore {

    /// Returns the stored credentials, or nil if no login was found.
    static func resolve() -> StoredCredentials? {
        if let fromKeychain = credentialsFromKeychain() { return fromKeychain }
        if let fromFile = credentialsFromFile() { return fromFile }
        return nil
    }

    // MARK: Keychain (via `security` CLI)

    /// Several items can share the service name (an old login, or another tool
    /// writing there), and a bare `-s` lookup returns whichever comes first.
    /// Claude Code keys its item by the macOS username, so ask for that account
    /// first and only then fall back to any match.
    private static func credentialsFromKeychain() -> StoredCredentials? {
        let service = "Claude Code-credentials"
        let lookups = [
            ["find-generic-password", "-a", NSUserName(), "-s", service, "-w"],
            ["find-generic-password", "-s", service, "-w"]
        ]
        for args in lookups {
            if let creds = keychainLookup(args) { return creds }
        }
        return nil
    }

    private static func keychainLookup(_ args: [String]) -> StoredCredentials? {
        guard let out = ProcessRunner.run("/usr/bin/security", args, timeout: 10),
              out.status == 0,
              let raw = String(data: out.stdout, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        return parse(Data(raw.utf8))
    }

    // MARK: Fallback file

    private static func credentialsFromFile() -> StoredCredentials? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let url = home.appendingPathComponent(".claude/.credentials.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return parse(data)
    }

    // MARK: JSON parse

    /// Reads `.claudeAiOauth`, or any other top-level object holding an
    /// `accessToken`, so a renamed key does not read as "not logged in".
    static func parse(_ data: Data) -> StoredCredentials? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return nil
        }
        var candidates: [Any] = []
        if let preferred = root["claudeAiOauth"] { candidates.append(preferred) }
        candidates.append(contentsOf: root.values)

        for case let obj as [String: Any] in candidates {
            if let token = obj["accessToken"] as? String, !token.isEmpty {
                let expiresAt = (obj["expiresAt"] as? NSNumber)?.doubleValue
                return StoredCredentials(accessToken: token,
                                         expiresAt: (expiresAt ?? 0) > 0 ? expiresAt : nil)
            }
        }
        return nil
    }
}

/// Asks the Claude Code CLI to bring its own login up to date.
///
/// The OAuth refresh token is single-use and owned by Claude Code. Refreshing it
/// here and failing to write it back would sign the user out of Claude Code
/// itself, so this app never touches it. Instead it runs `claude auth status`,
/// which loads (and if needed refreshes and saves) the stored login; the caller
/// then re-reads the store. Blocks, so run it off the main actor.
enum LoginRefresher {

    static func refresh() {
        guard let path = ClaudeCLI.path else { return }
        _ = ProcessRunner.run(path, ["auth", "status"], timeout: 30)
    }
}

/// Locates the installed Claude Code CLI. GUI apps launch with a minimal PATH,
/// so common install locations are checked directly.
enum ClaudeCLI {
    static var path: String? {
        let home = NSHomeDirectory()
        let candidates = [
            "\(home)/.local/bin/claude",
            "\(home)/.claude/local/claude",
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude"
        ]
        return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) })
    }
}
