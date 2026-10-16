import Foundation

/// One usage window from the endpoint (utilization 0..1, reset time ISO-UTC).
struct UsageWindow: Decodable {
    let utilization: Double
    let resets_at: String
}

/// The full response from GET /api/oauth/usage.
struct UsageResponse: Decodable {
    let five_hour: UsageWindow
    let seven_day: UsageWindow
    let seven_day_sonnet: UsageWindow?
}

/// Errors surfaced to the UI as distinct states.
enum UsageError: Error, LocalizedError {
    case noToken
    case unauthorized
    case rateLimited
    case http(Int)
    case network
    case decode

    var errorDescription: String? {
        switch self {
        case .noToken:      return "No Claude Code login"
        case .unauthorized: return "Login expired (401)"
        case .network:      return "Network error"
        case .rateLimited:  return "Rate limited (429)"
        case .http(let c):  return "HTTP error (\(c))"
        case .decode:       return "Could not read response"
        }
    }
}

/// Fetch usage from the Anthropic OAuth usage endpoint.
///
/// Mirrors the shared endpoint contract: three headers, map 401 and 429 to
/// dedicated errors so the UI can render clear states.
func fetchUsage(token: String, userAgent: String) async throws -> UsageResponse {
    var req = URLRequest(url: URL(string: "https://api.anthropic.com/api/oauth/usage")!)
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
    req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
    // URLSession's default is 60s per request; fail fast so the spinner and the
    // Refresh button come back promptly when offline.
    req.timeoutInterval = 15

    let (data, resp) = try await URLSession.shared.data(for: req)
    guard let http = resp as? HTTPURLResponse else { throw UsageError.decode }
    switch http.statusCode {
    case 200:
        do {
            return try JSONDecoder().decode(UsageResponse.self, from: data)
        } catch {
            throw UsageError.decode
        }
    case 401: throw UsageError.unauthorized
    case 429: throw UsageError.rateLimited
    default:  throw UsageError.http(http.statusCode)
    }
}

/// Convert a raw utilization value to a 0..100 percent.
///
/// Defensive: the contract says utilization is 0..1, but if a value above 1.5
/// arrives we treat it as already expressed on a 0..100 scale (matches JS core).
func percent(from utilization: Double) -> Double {
    let pct = utilization > 1.5 ? utilization : utilization * 100.0
    return max(0.0, min(100.0, pct))
}
