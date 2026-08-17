// swift-tools-version: 5.9
//
// pi-computer-use
// macOS computer use via Accessibility API + CGEvent, exposed as both an MCP
// stdio server and a CLI.
//
// Forked from nogu66/open-computer-use (MIT License).
//
import PackageDescription

let package = Package(
    name: "PiComputerUse",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "pi-computer-use", targets: ["PiComputerUseCLI"]),
        .library(name: "PiComputerUseCore", targets: ["PiComputerUseCore"]),
        .library(name: "PiComputerUseMac", targets: ["PiComputerUseMac"])
    ],
    targets: [
        .target(
            name: "PiComputerUseCore",
            path: "Sources/PiComputerUseCore"
        ),
        .target(
            name: "PiComputerUseMac",
            dependencies: ["PiComputerUseCore"],
            path: "Sources/PiComputerUseMac"
        ),
        .executableTarget(
            name: "PiComputerUseCLI",
            dependencies: ["PiComputerUseCore", "PiComputerUseMac"],
            path: "Sources/pi-computer-use"
        ),
        .testTarget(
            name: "PiComputerUseCoreTests",
            dependencies: ["PiComputerUseCore"],
            path: "Tests/PiComputerUseCoreTests"
        )
    ]
)
