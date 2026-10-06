// Records one window, and nothing else on the screen, as a run of JPEG
// frames named by the time each was taken (epoch ms), so a Terminal window
// can be shown live in the demo beside the board's recording. Uses
// ScreenCaptureKit (macOS 14 or later) and needs the Screen Recording
// permission. Stops on Ctrl-C or SIGTERM.
//
//   swiftc -O media/board-demo/window-recorder.swift -o /tmp/window-recorder
//   /tmp/window-recorder <window id> <out dir> [frames per second]
//
// The window id is the CGWindowID (the Terminal's AppleScript `id of window`).
import AppKit
import ScreenCaptureKit

// The window server connection ScreenCaptureKit needs, as an app would have.
_ = NSApplication.shared

let args = CommandLine.arguments
guard args.count >= 3, let windowID = UInt32(args[1]) else {
    FileHandle.standardError.write("usage: window-recorder <window id> <out dir> [fps]\n".data(using: .utf8)!)
    exit(2)
}
let outDir = URL(fileURLWithPath: args[2])
let fps = args.count > 3 ? Double(args[3]) ?? 8 : 8
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

var isRunning = true
signal(SIGINT) { _ in isRunning = false }
signal(SIGTERM) { _ in isRunning = false }

func save(_ image: CGImage, to url: URL) {
    let rep = NSBitmapImageRep(cgImage: image)
    if let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.9]) {
        try? data.write(to: url)
    }
}

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            FileHandle.standardError.write("no window \(windowID)\n".data(using: .utf8)!)
            exit(1)
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        config.width = Int(window.frame.width * 2)
        config.height = Int(window.frame.height * 2)
        config.showsCursor = false
        print("recording window \(windowID), \(Int(window.frame.width))x\(Int(window.frame.height))")
        var count = 0
        while isRunning {
            let started = Date()
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let ms = Int64(started.timeIntervalSince1970 * 1000)
            save(image, to: outDir.appendingPathComponent("\(ms).jpg"))
            count += 1
            let wait = 1 / fps - Date().timeIntervalSince(started)
            if wait > 0 { try await Task.sleep(nanoseconds: UInt64(wait * 1e9)) }
        }
        print("frames \(count)")
        exit(0)
    } catch {
        FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
        exit(1)
    }
}
RunLoop.main.run()
