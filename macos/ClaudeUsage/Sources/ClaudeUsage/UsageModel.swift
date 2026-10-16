import Foundation
import SwiftUI
import Combine

/// A single window's presentable state: percent plus reset timestamp.
struct WindowState: Equatable {
    var pct: Double
    var resetsAt: String
}

/// Config keys, kept in one place so views and the model agree.
enum ConfigKey {
    static let titleWindows = "titleWindows"   // "both" | "w" | "c"
    static let showSeverity = "showSeverity"   // Bool
    static let refreshSeconds = "refreshSeconds" // Int
    static let userAgent = "userAgent"         // String
    static let cacheSeconds = "cacheSeconds"   // Int
}

/// Observable state for the menu bar: current windows, loading, errors, and the
/// refresh timer. Holds an in-memory last-good cache so a failed refresh keeps
/// showing the previous numbers with a stale marker.
@MainActor
final class UsageModel: ObservableObject {

    @Published var session: WindowState?   // C, five_hour
    @Published var weekly: WindowState?    // W, seven_day
    @Published var sonnet: WindowState?    // seven_day_sonnet (display only)
    @Published var lastError: UsageError?
    @Published var isLoading: Bool = false
    @Published var isStale: Bool = false
    @Published var lastUpdated: Date?

    private var timer: Timer?
    private var lastGoodAt: Date?
    private var detectedUserAgent: String?

    // Config, read from UserDefaults with built-in defaults. There is no
    // in-app Settings UI; advanced users can override via `defaults write`.
    private var refreshSeconds: Int {
        let v = UserDefaults.standard.integer(forKey: ConfigKey.refreshSeconds)
        return v > 0 ? v : 180
    }
    private var cacheSeconds: Int {
        let v = UserDefaults.standard.integer(forKey: ConfigKey.cacheSeconds)
        return v > 0 ? v : 180
    }
    /// User-Agent override, else the CLI version detected once (off the main
    /// actor) and reused, instead of spawning `claude --version` every refresh.
    private func resolveUserAgent() async -> String {
        let v = UserDefaults.standard.string(forKey: ConfigKey.userAgent)
        if let v = v, !v.isEmpty { return v }
        if let ua = detectedUserAgent { return ua }
        let ua = await Task.detached { UserAgentDetector.detect() }.value
        detectedUserAgent = ua
        return ua
    }

    init() {
        start()
    }

    /// Start the refresh timer and do an immediate refresh.
    func start() {
        scheduleTimer()
        Task { await refresh() }
    }

    /// Rebuild the timer, e.g. if the refresh interval default changes.
    func scheduleTimer() {
        timer?.invalidate()
        let interval = TimeInterval(refreshSeconds)
        let t = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    /// True if the cached data is older than the cache window.
    var cacheIsStale: Bool {
        guard let at = lastGoodAt else { return true }
        return Date().timeIntervalSince(at) > TimeInterval(cacheSeconds)
    }

    /// Refresh only when the cache is stale (used on popover open).
    func refreshIfStale() async {
        if cacheIsStale { await refresh() }
    }

    /// Fetch fresh usage. On success, replace state. On failure, keep the last
    /// good numbers and flag them stale (except no-token, which clears state).
    ///
    /// Expired login recovery: if the stored token is past its expiry, or the
    /// endpoint answers 401, ask Claude Code to refresh its login, re-read the
    /// store, and retry once with the new token.
    func refresh() async {
        if isLoading { return }
        isLoading = true
        defer { isLoading = false }

        guard var creds = await Self.readCredentials() else {
            lastError = .noToken
            session = nil
            weekly = nil
            sonnet = nil
            isStale = false
            return
        }

        var refreshed = false
        if creds.isExpired, let fresh = await Self.refreshAndReread() {
            creds = fresh
            refreshed = true
        }

        let userAgent = await resolveUserAgent()

        do {
            let resp: UsageResponse
            do {
                resp = try await fetchUsage(token: creds.accessToken, userAgent: userAgent)
            } catch UsageError.unauthorized where !refreshed {
                guard let fresh = await Self.refreshAndReread(),
                      fresh.accessToken != creds.accessToken else {
                    throw UsageError.unauthorized
                }
                resp = try await fetchUsage(token: fresh.accessToken, userAgent: userAgent)
            }
            session = WindowState(pct: percent(from: resp.five_hour.utilization),
                                  resetsAt: resp.five_hour.resets_at)
            weekly = WindowState(pct: percent(from: resp.seven_day.utilization),
                                 resetsAt: resp.seven_day.resets_at)
            if let s = resp.seven_day_sonnet {
                sonnet = WindowState(pct: percent(from: s.utilization),
                                     resetsAt: s.resets_at)
            } else {
                sonnet = nil
            }
            lastError = nil
            isStale = false
            lastGoodAt = Date()
            lastUpdated = lastGoodAt
        } catch let err as UsageError {
            lastError = err
            // Keep last-good on transient errors; mark stale if we have data.
            isStale = (session != nil || weekly != nil)
        } catch {
            lastError = .network
            isStale = (session != nil || weekly != nil)
        }
    }

    // MARK: Off-main helpers

    /// Reads the stored login without blocking the main actor.
    private static func readCredentials() async -> StoredCredentials? {
        await Task.detached { TokenStore.resolve() }.value
    }

    /// Runs the CLI login refresh, then re-reads the store, off the main actor.
    private static func refreshAndReread() async -> StoredCredentials? {
        await Task.detached {
            LoginRefresher.refresh()
            return TokenStore.resolve()
        }.value
    }
}

/// Detects the User-Agent string, preferring the installed CLI version.
enum UserAgentDetector {
    static let fallback = "claude-code/1.0.0"

    static func detect() -> String {
        if let version = cliVersion() {
            return "claude-code/\(version)"
        }
        return fallback
    }

    /// Runs `claude --version` and extracts a version number, e.g. "1.2.3".
    private static func cliVersion() -> String? {
        guard let path = ClaudeCLI.path,
              let result = ProcessRunner.run(path, ["--version"], timeout: 10),
              result.status == 0,
              let out = String(data: result.stdout, encoding: .utf8) else { return nil }
        // Match the first dotted version token like 1.2.3.
        if let range = out.range(of: #"\d+\.\d+\.\d+"#, options: .regularExpression) {
            return String(out[range])
        }
        return nil
    }
}
