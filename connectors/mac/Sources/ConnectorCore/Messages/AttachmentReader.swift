import Foundation

/// Reads one attachment Messages keeps, for the desk's Files. Only files inside Messages' own attachments folder are read,
/// never through a link, at most `maxFile` bytes. Anything else stays on the Mac (the desk says so in words).
public struct AttachmentReader {
    /// `~/Library/Messages/Attachments`, resolved.
    public let root: URL
    public let maxFile: Int

    public init(root: URL, maxFile: Int = 16 * 1024 * 1024) {
        self.root = URL(fileURLWithPath: Self.real(root.path) ?? root.standardizedFileURL.path, isDirectory: true)
        self.maxFile = maxFile
    }

    /// realpath(3): every link resolved (URL.resolvingSymlinksInPath turns /private/var back into the /var link).
    static func real(_ path: String) -> String? {
        guard let p = realpath(path, nil) else { return nil }
        defer { free(p) }
        return String(cString: p)
    }

    public enum Outcome {
        case bytes(Data)
        case tooLarge
        case unreadable
    }

    public func read(_ a: ChatDB.Attachment, home: URL) -> Outcome {
        guard var path = a.path, !path.isEmpty, path.count < 2048, !path.contains("\0") else { return .unreadable }
        if path.hasPrefix("~/") { path = home.path + String(path.dropFirst(1)) }
        let url = URL(fileURLWithPath: path).standardizedFileURL
        // Inside the folder once every link is resolved; and the file itself is opened without following a link.
        let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard let dir = Self.real(url.deletingLastPathComponent().path), (dir + "/").hasPrefix(rootPath) else { return .unreadable }
        let fd = open(dir + "/" + url.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { return .unreadable }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { return .unreadable }
        guard st.st_size <= off_t(maxFile) else { return .tooLarge }
        guard st.st_size > 0 else { return .unreadable }
        var data = Data(count: Int(st.st_size))
        let n = data.withUnsafeMutableBytes { buf -> Int in
            var got = 0
            while got < buf.count {
                let r = Darwin.read(fd, buf.baseAddress!.advanced(by: got), buf.count - got)
                if r <= 0 { break }
                got += r
            }
            return got
        }
        guard n == data.count else { return .unreadable }
        return .bytes(data)
    }
}
