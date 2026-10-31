import SwiftUI
import PhotosUI
import AVFoundation
import ImageIO
import UniformTypeIdentifiers

// Permission decisions are scoped to the authenticated origin and actual requesting
// frame. An external or opaque iframe never inherits the host's media access.
enum MediaPermissionPolicy {
    static func allows(connection: Connection, originScheme: String, originHost: String,
                       originPort: Int, frameURL: URL?, authenticated: Bool, current: Bool) -> Bool {
        guard authenticated, current, let frameURL, connection.contains(frameURL),
              let base = connection.url else { return false }
        return originScheme.lowercased() == "https"
            && originHost.lowercased() == base.host?.lowercased()
            && (originPort == 0 ? 443 : originPort) == (base.port ?? 443)
    }
}

struct MediaPermissionIssue: Identifiable {
    let id = UUID()
    let message: String
}

@MainActor
enum MediaAccess {
    static func request(_ type: AVMediaType) async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: type) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: type)
        default: return false
        }
    }
    static func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }
}

enum ImagePreviewError: LocalizedError {
    case tooLarge, unreadable
    var errorDescription: String? {
        switch self {
        case .tooLarge: return "Choose an image smaller than 32 MB."
        case .unreadable: return "This image could not be opened. Choose another image or try again."
        }
    }
}

enum ImagePreviewDecoder {
    static let maximumFileBytes = 32 * 1024 * 1024
    static let maximumDimension = 4096
    static func load(_ url: URL) throws -> UIImage {
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize
        guard let size, size > 0 else { throw ImagePreviewError.unreadable }
        guard size <= maximumFileBytes else { throw ImagePreviewError.tooLarge }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumDimension,
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary) else { throw ImagePreviewError.unreadable }
        return UIImage(cgImage: image)
    }
    static func bounded(_ image: UIImage) -> UIImage {
        let longest = max(image.size.width, image.size.height)
        guard longest * image.scale > CGFloat(maximumDimension) else { return image }
        let ratio = CGFloat(maximumDimension) / longest
        let size = CGSize(width: image.size.width * ratio, height: image.size.height * ratio)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }
}

@MainActor
final class ImagePreviewRequest: ObservableObject {
    private var generation = UUID()
    private var active = true
    func begin() -> UUID { generation = UUID(); return generation }
    func accepts(_ ticket: UUID) -> Bool { active && generation == ticket }
    func cancel() { active = false; generation = UUID() }
    func appear() { active = true }
}

@MainActor
struct ImageToolsView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var request = ImagePreviewRequest()
    @State private var selectionTicket = UUID()
    @State private var image: UIImage?
    @State private var photos = false
    @State private var files = false
    @State private var camera = false
    @State private var busy = false
    @State private var message: String?
    @State private var permission: MediaPermissionIssue?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let image {
                    ZoomableImageView(image: image).accessibilityIdentifier("image-preview")
                } else {
                    VStack(spacing: 20) {
                        Image(systemName: "photo").font(.system(size: 48)).accessibilityHidden(true)
                        Text("View an image").font(.title2.bold())
                        Text("Choose a photo or file, or take a picture. It stays on this device.")
                            .font(.body).multilineTextAlignment(.center).foregroundStyle(.white.opacity(0.75))
                        Button("Choose photo") { choosePhoto() }.buttonStyle(.borderedProminent)
                        Button("Open image file") { chooseFile() }.buttonStyle(.bordered)
                        Button("Take photo") { takePhoto() }.buttonStyle(.bordered)
                    }.padding(32).foregroundStyle(.white).disabled(busy)
                }
                if busy { ProgressView("Opening image…").padding(20).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)) }
            }
            .navigationTitle("Images").navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) { Button("Close") { request.cancel(); dismiss() } }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Button("Choose photo") { choosePhoto() }
                        Button("Open image file") { chooseFile() }
                        Button("Take photo") { takePhoto() }
                        Button("Permissions") { MediaAccess.openSettings() }
                    } label: { Image(systemName: "plus").accessibilityLabel("Open another image") }
                    .disabled(busy)
                }
            }
        }
        .onAppear { request.appear() }
        .onDisappear {
            // A full-screen camera covers this view without ending its session.
            if !camera && !photos && !files { request.cancel() }
        }
        .sheet(isPresented: $photos, onDismiss: { _ = request.begin() }) {
            let ticket = selectionTicket
            SelectedPhotoPicker { result in
                guard request.accepts(ticket) else { return }
                photos = false
                switch result {
                case .success(let selected): image = selected
                case .failure(let error): message = error.localizedDescription
                }
            } cancelled: { _ = request.begin(); photos = false }
        }
        .fullScreenCover(isPresented: $camera) {
            let ticket = selectionTicket
            CameraPhotoPicker { selected in
                guard request.accepts(ticket) else { return }
                camera = false
                if let selected { image = ImagePreviewDecoder.bounded(selected) }
            }.ignoresSafeArea()
        }
        .fileImporter(isPresented: $files, allowedContentTypes: [.image]) { result in
            guard case .success(let url) = result else {
                if case .failure(let error) = result { message = error.localizedDescription }
                return
            }
            let ticket = selectionTicket
            guard request.accepts(ticket) else { return }
            busy = true
            Task {
                let loaded = await Task.detached(priority: .userInitiated) { () -> Result<UIImage, Error> in
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    return Result { try ImagePreviewDecoder.load(url) }
                }.value
                guard request.accepts(ticket) else { return }
                busy = false
                switch loaded {
                case .success(let selected): image = selected
                case .failure(let error): message = error.localizedDescription
                }
            }
        }
        .alert("Cannot open image", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK") { message = nil }
        } message: { Text(message ?? "") }
        .alert(item: $permission) { issue in
            Alert(title: Text("Camera access"), message: Text(issue.message),
                  primaryButton: .default(Text("Open Settings"), action: MediaAccess.openSettings),
                  secondaryButton: .cancel(Text("Not now")))
        }
    }
    private func choosePhoto() { selectionTicket = request.begin(); photos = true }
    private func chooseFile() { selectionTicket = request.begin(); files = true }
    private func takePhoto() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            message = "This device does not have an available camera. You can still choose a photo or image file."; return
        }
        let ticket = request.begin(); selectionTicket = ticket
        Task {
            let granted = await MediaAccess.request(.video)
            guard request.accepts(ticket) else { return }
            if granted { camera = true }
            else { permission = .init(message: "Allow Camera in Settings to take a picture. You can still choose an existing photo.") }
        }
    }
}

struct SelectedPhotoPicker: UIViewControllerRepresentable {
    let selected: (Result<UIImage, Error>) -> Void
    let cancelled: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration()
        config.filter = .images; config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}
    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let parent: SelectedPhotoPicker
        init(_ parent: SelectedPhotoPicker) { self.parent = parent }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard let provider = results.first?.itemProvider else { parent.cancelled(); return }
            // The provider's URL only exists during this callback: decode it here,
            // then deliver the bounded image to the main thread. No library crawl.
            provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [parent] url, error in
                let result: Result<UIImage, Error>
                if let url { result = Result { try ImagePreviewDecoder.load(url) } }
                else { result = .failure(error ?? ImagePreviewError.unreadable) }
                DispatchQueue.main.async { parent.selected(result) }
            }
        }
    }
}

struct CameraPhotoPicker: UIViewControllerRepresentable {
    let selected: (UIImage?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController(); picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier]; picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPhotoPicker
        init(_ parent: CameraPhotoPicker) { self.parent = parent }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.selected(nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            parent.selected(info[.originalImage] as? UIImage)
        }
    }
}

struct ZoomableImageView: UIViewRepresentable {
    let image: UIImage
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIScrollView {
        let scroll = ImageZoomScrollView()
        scroll.minimumZoomScale = 1; scroll.maximumZoomScale = 6
        scroll.delegate = context.coordinator
        let view = context.coordinator.imageView
        scroll.imageView = view
        view.contentMode = .scaleAspectFit
        view.accessibilityLabel = "Selected image. Pinch to zoom and drag to pan."
        view.isAccessibilityElement = true
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scroll.addSubview(view)
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)
        return scroll
    }
    func updateUIView(_ scroll: UIScrollView, context: Context) {
        let view = context.coordinator.imageView
        if view.image !== image { scroll.setZoomScale(1, animated: false); view.image = image }
        if scroll.zoomScale == 1 { view.frame = scroll.bounds; scroll.contentSize = scroll.bounds.size }
    }
    final class Coordinator: NSObject, UIScrollViewDelegate {
        let imageView = UIImageView()
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        @objc func toggleZoom(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? UIScrollView else { return }
            if scroll.zoomScale > 1 { scroll.setZoomScale(1, animated: true) }
            else {
                let point = gesture.location(in: imageView)
                let size = CGSize(width: scroll.bounds.width / 3, height: scroll.bounds.height / 3)
                scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }
    }
}

final class ImageZoomScrollView: UIScrollView {
    weak var imageView: UIImageView?
    override func layoutSubviews() {
        super.layoutSubviews()
        if zoomScale == 1 {
            imageView?.frame = CGRect(origin: .zero, size: bounds.size)
            if contentSize != bounds.size { contentSize = bounds.size }
        }
    }
}
