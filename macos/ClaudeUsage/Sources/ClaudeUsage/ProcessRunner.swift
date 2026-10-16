import Foundation

/// Runs a short-lived helper process (`security`, `claude`) with a hard timeout.
///
/// A keychain access prompt or a stuck CLI must never wedge a refresh. These
/// calls used to run synchronously on the main actor with no timeout, so one
/// blocked `security` or `claude` call froze the menu bar and the Refresh button.
enum ProcessRunner {

    struct Output {
        let status: Int32
        let stdout: Data
    }

    /// Runs `path` with `args` and returns its exit status and stdout, or nil if
    /// it could not launch or did not finish within `timeout` seconds (it is
    /// terminated in that case). Blocks the calling thread, so call it off the
    /// main actor.
    static func run(_ path: String, _ args: [String], timeout: TimeInterval) -> Output? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: path)
        task.arguments = args
        task.standardInput = FileHandle.nullDevice

        let outPipe = Pipe()
        task.standardOutput = outPipe
        task.standardError = FileHandle.nullDevice

        // Drain stdout while the process runs so a large output cannot fill
        // the pipe buffer and deadlock it.
        var collected = Data()
        let lock = NSLock()
        outPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            lock.lock(); collected.append(chunk); lock.unlock()
        }

        let done = DispatchSemaphore(value: 0)
        task.terminationHandler = { _ in done.signal() }

        do {
            try task.run()
        } catch {
            outPipe.fileHandleForReading.readabilityHandler = nil
            return nil
        }

        if done.wait(timeout: .now() + timeout) == .timedOut {
            task.terminate()
            _ = done.wait(timeout: .now() + 1)
            outPipe.fileHandleForReading.readabilityHandler = nil
            return nil
        }

        outPipe.fileHandleForReading.readabilityHandler = nil
        let rest = outPipe.fileHandleForReading.readDataToEndOfFile()
        lock.lock(); collected.append(rest); lock.unlock()
        return Output(status: task.terminationStatus, stdout: collected)
    }
}
