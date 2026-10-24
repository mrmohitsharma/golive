// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "cg_streamer",
    platforms: [
        // HaishinKit 2.x requires iOS 15.
        .iOS("15.0")
    ],
    products: [
        .library(name: "cg-streamer", targets: ["cg_streamer"])
    ],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework"),
        // SRT publishing (BSD-3-Clause). https://github.com/HaishinKit/HaishinKit.swift
        .package(url: "https://github.com/HaishinKit/HaishinKit.swift.git", exact: "2.2.5")
    ],
    targets: [
        .target(
            name: "cg_streamer",
            dependencies: [
                .product(name: "FlutterFramework", package: "FlutterFramework"),
                .product(name: "HaishinKit", package: "HaishinKit.swift"),
                .product(name: "SRTHaishinKit", package: "HaishinKit.swift")
            ],
            resources: [
                .process("PrivacyInfo.xcprivacy")
            ]
        )
    ]
)
