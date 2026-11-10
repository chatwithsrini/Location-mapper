import ExpoModulesCore
import UIKit
import ImageIO
import CoreLocation
import UniformTypeIdentifiers

public class GeoPhotoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("GeoPhoto")

    AsyncFunction("renderAndTag") { (sourceUri: String, destinationUri: String, details: [String: Any]) throws -> [String: Any] in
      let sourceURL = Self.fileURL(sourceUri)
      let destinationURL = Self.fileURL(destinationUri)
      var completed = false
      defer {
        if !completed { try? FileManager.default.removeItem(at: destinationURL) }
      }
      guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil) else { throw NSError(domain: "GeoPhoto", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unsupported or unreadable image"]) }
      let properties = (CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]) ?? [:]
      let width = (properties[kCGImagePropertyPixelWidth as String] as? NSNumber)?.intValue ?? 0
      let height = (properties[kCGImagePropertyPixelHeight as String] as? NSNumber)?.intValue ?? 0
      guard width > 0, height > 0 else { throw NSError(domain: "GeoPhoto", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unsupported or unreadable image"]) }
      // Decode directly from the file into a bounded thumbnail. Never make a
      // full-resolution UIImage copy for very large camera images.
      let sourceImage: UIImage? = [1024, 768, 512, 384].lazy.compactMap { maxEdge -> UIImage? in
        let options: [CFString: Any] = [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: maxEdge,
          kCGImageSourceShouldCache: false
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: thumbnail, scale: 1, orientation: .up)
      }.first
      guard let sourceImage else {
        throw NSError(domain: "GeoPhoto", code: 2, userInfo: [NSLocalizedDescriptionKey: "This image could not be decoded at a safe size on this device"])
      }
      guard let rendered = Self.render(image: sourceImage, details: details) else {
        throw NSError(domain: "GeoPhoto", code: 3, userInfo: [NSLocalizedDescriptionKey: "JPEG rendering failed"])
      }
      guard let renderedCG = rendered.cgImage,
            let destination = CGImageDestinationCreateWithURL(destinationURL as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw NSError(domain: "GeoPhoto", code: 3, userInfo: [NSLocalizedDescriptionKey: "JPEG rendering failed"])
      }
      var outputProperties = properties
      outputProperties.removeValue(forKey: kCGImagePropertyGPSDictionary as String)
      outputProperties[kCGImagePropertyOrientation as String] = 1
      outputProperties[kCGImagePropertyPixelWidth as String] = renderedCG.width
      outputProperties[kCGImagePropertyPixelHeight as String] = renderedCG.height
      outputProperties[kCGImageDestinationLossyCompressionQuality as String] = 0.94
      let latitude = (details["latitude"] as? NSNumber)?.doubleValue ?? 0
      let longitude = (details["longitude"] as? NSNumber)?.doubleValue ?? 0
      let gps: [String: Any] = [
        kCGImagePropertyGPSLatitude as String: abs(latitude),
        kCGImagePropertyGPSLatitudeRef as String: latitude < 0 ? "S" : "N",
        kCGImagePropertyGPSLongitude as String: abs(longitude),
        kCGImagePropertyGPSLongitudeRef as String: longitude < 0 ? "W" : "E",
        kCGImagePropertyGPSVersion as String: "2.3.0",
        kCGImagePropertyGPSMapDatum as String: "WGS-84"
      ]
      outputProperties[kCGImagePropertyGPSDictionary as String] = gps
      if let captureTimeExif = details["captureTimeExif"] as? String, !captureTimeExif.isEmpty {
        var tiff = outputProperties[kCGImagePropertyTIFFDictionary as String] as? [String: Any] ?? [:]
        tiff[kCGImagePropertyTIFFDateTime as String] = captureTimeExif
        outputProperties[kCGImagePropertyTIFFDictionary as String] = tiff
        var exif = outputProperties[kCGImagePropertyExifDictionary as String] as? [String: Any] ?? [:]
        exif[kCGImagePropertyExifDateTimeOriginal as String] = captureTimeExif
        exif[kCGImagePropertyExifDateTimeDigitized as String] = captureTimeExif
        outputProperties[kCGImagePropertyExifDictionary as String] = exif
      }
      CGImageDestinationAddImage(destination, renderedCG, outputProperties as CFDictionary)
      guard CGImageDestinationFinalize(destination) else {
        try? FileManager.default.removeItem(at: destinationURL)
        throw NSError(domain: "GeoPhoto", code: 4, userInfo: [NSLocalizedDescriptionKey: "JPEG could not be completed"])
      }
      guard let outputSource = CGImageSourceCreateWithURL(destinationURL as CFURL, nil),
            let outputProps = CGImageSourceCopyPropertiesAtIndex(outputSource, 0, nil) as? [String: Any],
            let verifiedGPS = outputProps[kCGImagePropertyGPSDictionary as String] as? [String: Any],
            let outLat = (verifiedGPS[kCGImagePropertyGPSLatitude as String] as? NSNumber)?.doubleValue,
            let outLon = (verifiedGPS[kCGImagePropertyGPSLongitude as String] as? NSNumber)?.doubleValue else {
        completed = true
        return ["verified": false, "width": renderedCG.width, "height": renderedCG.height]
      }
      let latRef = verifiedGPS[kCGImagePropertyGPSLatitudeRef as String] as? String ?? "N"
      let lonRef = verifiedGPS[kCGImagePropertyGPSLongitudeRef as String] as? String ?? "E"
      let signedLat = latRef == "S" ? -outLat : outLat
      let signedLon = lonRef == "W" ? -outLon : outLon
      let verified = abs(signedLat - latitude) < 0.000001 && abs(signedLon - longitude) < 0.000001
      completed = true
      return ["verified": verified, "width": renderedCG.width, "height": renderedCG.height]
    }
  }

  private static func fileURL(_ value: String) -> URL {
    if let url = URL(string: value), url.isFileURL { return url }
    return URL(fileURLWithPath: value)
  }

  private static func render(image: UIImage, details: [String: Any]) -> UIImage? {
    let size = image.size
    UIGraphicsBeginImageContextWithOptions(size, true, 1)
    defer { UIGraphicsEndImageContext() }
    guard UIGraphicsGetCurrentContext() != nil else { return nil }
    image.draw(in: CGRect(origin: .zero, size: size))
    let addressValue = (details["address"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let address = details["addressEnabled"] as? Bool != false && !addressValue.isEmpty
      ? "\(details["addressLabel"] as? String ?? "Approx. ")\(addressValue)" : ""
    let time = details["dateTimeEnabled"] as? Bool != false ? (details["displayTime"] as? String ?? "") : ""
    let coordinates = details["coordinatesEnabled"] as? Bool != false
    guard !address.isEmpty || !time.isEmpty || coordinates else { return UIGraphicsGetImageFromCurrentImageContext() ?? image }
    let scale = max(0.65, min(size.width, size.height) / 420)
    let pad = 12 * scale
    let font = UIFont.systemFont(ofSize: 15 * scale, weight: .semibold)
    let textColor: UIColor = (details["style"] as? String == "light") ? UIColor(red: 0.09, green: 0.14, blue: 0.12, alpha: 1) : .white
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: textColor]
    let lineHeight = font.lineHeight * 1.12
    let cardWidth = size.width * 0.92
    let contentWidth = cardWidth - 58 * scale
    func wrap(_ value: String) -> [String] {
      var result: [String] = []
      var current = ""
      for word in value.split(whereSeparator: { $0.isWhitespace }).map(String.init) {
        let candidate = current.isEmpty ? word : "\(current) \(word)"
        if !current.isEmpty && (candidate as NSString).size(withAttributes: attrs).width > contentWidth {
          result.append(current)
          current = word
        } else {
          current = candidate
        }
      }
      if !current.isEmpty { result.append(current) }
      return result
    }
    let lines = (time.isEmpty ? [] : wrap(time)) + (address.isEmpty ? [] : wrap(address))
    let coordinateHeight = coordinates ? 17 * scale : 0
    let cardHeight = max(48 * scale, CGFloat(lines.count) * lineHeight + coordinateHeight + pad * 2)
    let placement = details["placement"] as? String ?? "bottom-left"
    let x = placement.hasSuffix("right") ? size.width - pad - cardWidth : pad
    let y = placement.hasPrefix("top") ? pad : size.height - pad - cardHeight
    let rect = CGRect(x: x, y: y, width: cardWidth, height: cardHeight)
    let style = details["style"] as? String ?? "dark"
    let background: UIColor = style == "light" ? UIColor(white: 1, alpha: 0.66) : (style == "solid" ? UIColor(red: 0.09, green: 0.42, blue: 0.29, alpha: 1) : UIColor(red: 0.04, green: 0.05, blue: 0.05, alpha: 0.58))
    background.setFill()
    UIBezierPath(roundedRect: rect, cornerRadius: 15 * scale).fill()
    let pinCenter = CGPoint(x: x + 22 * scale, y: y + cardHeight / 2)
    UIColor(red: 0.47, green: 0.78, blue: 0.60, alpha: 1).setFill()
    let pinTail = UIBezierPath()
    pinTail.move(to: CGPoint(x: pinCenter.x - 5 * scale, y: pinCenter.y + 1 * scale))
    pinTail.addLine(to: CGPoint(x: pinCenter.x, y: pinCenter.y + 12 * scale))
    pinTail.addLine(to: CGPoint(x: pinCenter.x + 5 * scale, y: pinCenter.y + 1 * scale))
    pinTail.close()
    pinTail.fill()
    UIBezierPath(ovalIn: CGRect(x: pinCenter.x - 7 * scale, y: pinCenter.y - 9 * scale, width: 14 * scale, height: 14 * scale)).fill()
    UIColor(red: 0.06, green: 0.11, blue: 0.09, alpha: 1).setFill()
    UIBezierPath(ovalIn: CGRect(x: pinCenter.x - 2.5 * scale, y: pinCenter.y - 5.5 * scale, width: 5 * scale, height: 5 * scale)).fill()
    for (index, line) in lines.enumerated() {
      (line as NSString).draw(at: CGPoint(x: x + 42 * scale, y: y + pad + CGFloat(index) * lineHeight), withAttributes: attrs)
    }
    if coordinates, let lat = details["latitude"] as? NSNumber, let lon = details["longitude"] as? NSNumber {
      let coordFont = UIFont.systemFont(ofSize: 12 * scale, weight: .semibold)
      let coordAttrs: [NSAttributedString.Key: Any] = [.font: coordFont, .foregroundColor: textColor]
      let latText = String(format: "Lat: %.6f", lat.doubleValue)
      let lonText = String(format: "Long: %.6f", lon.doubleValue)
      let baselineY = y + pad + CGFloat(lines.count) * lineHeight
      (latText as NSString).draw(at: CGPoint(x: x + 42 * scale, y: baselineY), withAttributes: coordAttrs)
      let rightX = x + cardWidth - pad - (lonText as NSString).size(withAttributes: coordAttrs).width
      (lonText as NSString).draw(at: CGPoint(x: max(x + 42 * scale + (latText as NSString).size(withAttributes: coordAttrs).width + 8 * scale, rightX), y: baselineY), withAttributes: coordAttrs)
    }
    return UIGraphicsGetImageFromCurrentImageContext()
  }
}
