import AppKit
import Foundation

// 纯黑底 + 白色软件名。用法：swift draw.swift <输出目录>
// 输出 16/32/64/128/256/512/1024 七个尺寸，供 generate.mjs 组装 iconset 与各档 png。

let sizes = [16, 32, 64, 128, 256, 512, 1024]

func drawIcon(size: Int, to path: String) throws {
    let side = CGFloat(size)
    guard
        let context = CGContext(
            data: nil,
            width: size,
            height: size,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
    else {
        throw NSError(domain: "ember.icon", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法创建 \(size)px 位图上下文"])
    }

    // 纯黑背景：四角必须是 #000000
    context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: side, height: side))
    context.setShouldAntialias(true)

    let fontSize = side * 0.215
    let font = NSFont(name: "Helvetica-Bold", size: fontSize) ?? NSFont.boldSystemFont(ofSize: fontSize)
    let text = "Ember" as NSString
    let attributes: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor(calibratedRed: 1, green: 1, blue: 1, alpha: 1),
    ]
    let textSize = text.size(withAttributes: attributes)

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    text.draw(
        at: NSPoint(
            x: (side - textSize.width) / 2,
            y: (side - textSize.height) / 2
        ),
        withAttributes: attributes
    )
    NSGraphicsContext.restoreGraphicsState()

    guard let image = context.makeImage() else {
        throw NSError(domain: "ember.icon", code: 2, userInfo: [NSLocalizedDescriptionKey: "\(size)px 生成位图失败"])
    }
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "ember.icon", code: 3, userInfo: [NSLocalizedDescriptionKey: "\(size)px 编码 PNG 失败"])
    }
    try data.write(to: URL(fileURLWithPath: path))
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write(Data("用法：swift draw.swift <输出目录>\n".utf8))
    exit(2)
}
let outputDirectory = arguments[1]

do {
    for size in sizes {
        try drawIcon(size: size, to: "\(outputDirectory)/\(size).png")
    }
    print("drawn: \(sizes.map { "\($0)px" }.joined(separator: ", "))")
} catch {
    FileHandle.standardError.write(Data("图标绘制失败：\(error)\n".utf8))
    exit(1)
}
