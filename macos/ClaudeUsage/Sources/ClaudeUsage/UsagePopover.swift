import SwiftUI

/// The dropdown detail shown when the menu bar item is clicked.
///
/// Three window rows (session, weekly, sonnet), each with a bar and reset text,
/// plus Refresh and Quit actions.
struct UsagePopover: View {
    @EnvironmentObject var model: UsageModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            if model.session == nil && model.weekly == nil {
                emptyState
            } else {
                if let c = model.session {
                    row(title: "Session", state: c, reset: Formatters.resetRelative(c.resetsAt))
                }
                if let w = model.weekly {
                    row(title: "Weekly", state: w, reset: Formatters.resetLocal(w.resetsAt))
                }
                if let s = model.sonnet {
                    row(title: "Sonnet", state: s, reset: Formatters.resetLocal(s.resetsAt))
                }
                if model.isStale {
                    Text("Showing cached data.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Divider()
            actions
        }
        .padding(14)
        .frame(width: 300)
        .task { await model.refreshIfStale() }
    }

    // MARK: Sections

    private var header: some View {
        HStack {
            Text("Claude Code Usage").font(.headline)
            Spacer()
            if model.isLoading {
                ProgressView().controlSize(.small)
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(model.lastError?.errorDescription ?? "No data yet")
                .foregroundStyle(.secondary)
            if case .noToken = model.lastError {
                Text("Run `claude` to sign in, then refresh.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if case .unauthorized = model.lastError {
                Text("Run `claude` and sign in again, then refresh.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func row(title: String, state: WindowState, reset: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(title).font(.subheadline).bold()
                Spacer()
                Text(Formatters.pct(state.pct))
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(MenuBarLabel.color(for: state.pct))
            }
            ProgressView(value: min(state.pct, 100), total: 100)
                .tint(MenuBarLabel.color(for: state.pct))
            if !reset.isEmpty {
                Text(reset).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var actions: some View {
        HStack {
            Button("Refresh") {
                Task { await model.refresh() }
            }
            Spacer()
            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
        }
    }
}
