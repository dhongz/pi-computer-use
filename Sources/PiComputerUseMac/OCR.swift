//
//  OCR.swift
//  Local Vision OCR with an explicit provider seam for future third-party OCR.
//

import Foundation
import CoreGraphics
import ImageIO
import Vision

public enum OCRRecognitionLevel: String { case fast, accurate }

public struct OCRRequest {
    public let image: CGImage
    /// Top-left-origin normalized coordinates. nil means the complete image.
    public let region: CGRect?
    public let languages: [String]
    public let recognitionLevel: OCRRecognitionLevel

    public init(image: CGImage, region: CGRect? = nil, languages: [String] = [], recognitionLevel: OCRRecognitionLevel = .fast) {
        self.image = image
        self.region = region
        self.languages = languages
        self.recognitionLevel = recognitionLevel
    }
}

public struct OCRToken {
    public let text: String
    public let confidence: Float
    /// Top-left-origin normalized coordinates in the original image.
    public let normalizedBounds: CGRect

    public var json: [String: Any] {
        var value: [String: Any] = ["text": text, "confidence": confidence]
        if let bounds = jsonRect(normalizedBounds) { value["bounds"] = bounds }
        return value
    }
}

public protocol OCRProvider {
    var identifier: String { get }
    var isRemote: Bool { get }
    func recognize(_ request: OCRRequest) throws -> [OCRToken]
}

public enum OCRProviderError: Error, CustomStringConvertible {
    case notConfigured(String)
    case unavailable(String)
    public var description: String {
        switch self {
        case .notConfigured(let message), .unavailable(let message): return message
        }
    }
}

/// Apple's on-device OCR. No image or recognized text leaves the machine.
public struct VisionOCRProvider: OCRProvider {
    public let identifier = "vision"
    public let isRemote = false

    public init() {}

    public func recognize(_ request: OCRRequest) throws -> [OCRToken] {
        let visionRequest = VNRecognizeTextRequest()
        visionRequest.recognitionLevel = request.recognitionLevel == .accurate ? .accurate : .fast
        visionRequest.usesLanguageCorrection = request.recognitionLevel == .accurate
        if !request.languages.isEmpty { visionRequest.recognitionLanguages = request.languages }
        var image = request.image
        var regionOrigin = CGPoint.zero
        var regionScale = CGSize(width: 1, height: 1)
        if let region = request.region {
            // CGImage crops use a bottom-left origin; the public contract uses top-left.
            let crop = CGRect(
                x: region.minX * CGFloat(image.width),
                y: (1 - region.maxY) * CGFloat(image.height),
                width: region.width * CGFloat(image.width),
                height: region.height * CGFloat(image.height)
            ).intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
            if let cropped = image.cropping(to: crop), crop.width > 0, crop.height > 0 {
                image = cropped
                regionOrigin = CGPoint(x: region.minX, y: region.minY)
                regionScale = CGSize(width: region.width, height: region.height)
            }
        }
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([visionRequest])
        return (visionRequest.results ?? []).compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let box = observation.boundingBox
            let localTopLeft = CGRect(x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height)
            let topLeft = CGRect(
                x: regionOrigin.x + localTopLeft.minX * regionScale.width,
                y: regionOrigin.y + localTopLeft.minY * regionScale.height,
                width: localTopLeft.width * regionScale.width,
                height: localTopLeft.height * regionScale.height
            )
            return OCRToken(text: candidate.string, confidence: candidate.confidence, normalizedBounds: topLeft)
        }
    }
}

/// Placeholder provider that makes the future remote integration explicit.
/// It is intentionally not silently enabled and never transmits screenshots.
public struct UnconfiguredRemoteOCRProvider: OCRProvider {
    public let identifier: String
    public let isRemote = true
    public init(identifier: String = "http") { self.identifier = identifier }
    public func recognize(_ request: OCRRequest) throws -> [OCRToken] {
        throw OCRProviderError.notConfigured("remote OCR provider '\(identifier)' is not configured; use provider=vision or install an explicit provider")
    }
}

public func configuredOCRProvider(_ requested: String? = nil) -> OCRProvider {
    let name = (requested ?? ProcessInfo.processInfo.environment["PCU_OCR_PROVIDER"] ?? "vision").lowercased()
    switch name {
    case "vision", "apple", "local": return VisionOCRProvider()
    case "http", "remote", "third-party", "third_party": return UnconfiguredRemoteOCRProvider()
    default: return UnconfiguredRemoteOCRProvider(identifier: name)
    }
}

public func cgImageFromPNG(_ data: Data) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}
