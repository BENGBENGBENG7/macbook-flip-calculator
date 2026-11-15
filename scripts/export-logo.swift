import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    fatalError("Usage: swift scripts/export-logo.swift <project-directory>")
}
let project = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let source = try String(contentsOf: project.appendingPathComponent("logo.svg"), encoding: .utf8)
let opaque = source.replacingOccurrences(of: "id=\"app-background\" width=\"1024\" height=\"1024\" rx=\"230\"", with: "id=\"app-background\" width=\"1024\" height=\"1024\" rx=\"0\"")
let mac = source.replacingOccurrences(of: "viewBox=\"0 0 1024 1024\"", with: "viewBox=\"-128 -128 1280 1280\"")

func export(_ svg: String, _ name: String, _ size: Int) throws {
    guard let image = NSImage(data: Data(svg.utf8)),
          let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
              bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
              colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fatalError("Cannot render \(name)")
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: size, height: size).fill()
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero,
               operation: .copy, fraction: 1, respectFlipped: false,
               hints: [.interpolation: NSImageInterpolation.high])
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        fatalError("Cannot encode \(name)")
    }
    try png.write(to: project.appendingPathComponent(name))
}

try export(source, "logo-source.png", 1024)
try export(source, "favicon-green.png", 64)
try export(opaque, "apple-touch-icon-green.png", 180)
try export(opaque, "apple-touch-icon.png", 180)
try export(opaque, "icon-green-192.png", 192)
try export(opaque, "icon-192.png", 192)
try export(opaque, "icon-green-512.png", 512)
try export(opaque, "icon-512.png", 512)
try export(opaque, "icon-green-maskable-512.png", 512)
let desktop = project.appendingPathComponent("desktop", isDirectory: true)
if FileManager.default.fileExists(atPath: desktop.path) {
    try mac.write(to: desktop.appendingPathComponent("icon.svg"), atomically: true, encoding: .utf8)
    try export(mac, "desktop/icon-1024.png", 1024)
}
print("Exported green calculator icons from logo.svg")
