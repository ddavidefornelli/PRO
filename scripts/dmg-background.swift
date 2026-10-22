import AppKit

// Finder uses point coordinates; render at 2× for Retina displays.
let width: CGFloat = 660
let height: CGFloat = 420
let image = NSImage(size: NSSize(width: width, height: height))
image.lockFocus()
NSColor(calibratedRed: 0.055, green: 0.065, blue: 0.06, alpha: 1).setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: width, height: height)).fill()

func text(_ value: String, x: CGFloat, y: CGFloat, size: CGFloat, color: NSColor, weight: NSFont.Weight = .regular) {
    (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [
        .font: NSFont.systemFont(ofSize: size, weight: weight),
        .foregroundColor: color
    ])
}
let green = NSColor(calibratedRed: 0.68, green: 0.86, blue: 0.63, alpha: 1)
text("prune", x: 46, y: 326, size: 38, color: green, weight: .semibold)
text("A little focus. A little growth.", x: 48, y: 300, size: 14, color: .lightGray)
text("MAKE ROOM FOR WHAT MATTERS", x: 48, y: 374, size: 10, color: .gray, weight: .medium)

// Icon centers are (180, 205) and (480, 205) in Finder coordinates.
let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: 286, y: 215))
arrow.line(to: NSPoint(x: 374, y: 215))
arrow.move(to: NSPoint(x: 362, y: 227))
arrow.line(to: NSPoint(x: 374, y: 215))
arrow.line(to: NSPoint(x: 362, y: 203))
arrow.lineWidth = 2.5
green.setStroke()
arrow.stroke()
text("Drag prune into Applications", x: 204, y: 83, size: 17, color: .white, weight: .medium)
text("Then eject this disk and open prune from Applications.", x: 151, y: 56, size: 13, color: .lightGray)
image.unlockFocus()

let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1320, pixelsHigh: 840,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
bitmap.size = NSSize(width: width, height: height)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
image.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
