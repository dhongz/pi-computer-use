//
//  VersionTests.swift
//  PiComputerUse / PiComputerUseCoreTests
//

import XCTest
@testable import PiComputerUseCore

final class VersionTests: XCTestCase {

    func testVersionLooksSemver() {
        let v = PiComputerUse.version
        let parts = v.split(separator: ".")
        XCTAssertEqual(parts.count, 3, "version '\(v)' must be MAJOR.MINOR.PATCH")
        for p in parts {
            XCTAssertNotNil(Int(p), "version part '\(p)' must be an integer")
        }
    }

    func testServerNameNotEmpty() {
        XCTAssertFalse(PiComputerUse.serverName.isEmpty)
    }
}
