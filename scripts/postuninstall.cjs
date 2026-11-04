#!/usr/bin/env node

const { spawn } = require("node:child_process");

// Platform-specific packages to uninstall
const platformPackages = [
	"memory-master-linux-x64",
	"memory-master-linux-arm64",
	"memory-master-darwin-x64",
	"memory-master-darwin-arm64",
	"memory-master-windows-arm64",
	"memory-master-windows-x64",
];

// Detect package manager
const packageManager = process.env.npm_config_user_agent?.split("/")[0] || "npm";

console.log("Cleaning up platform-specific packages...");

// Try to uninstall all platform packages
for (const pkg of platformPackages) {
	const args = packageManager === "bun" ? ["remove", "-g", pkg] : ["uninstall", "-g", pkg];

	const child = spawn(packageManager, args, {
		stdio: "pipe", // Don't show output to avoid spam
		windowsHide: true,
	});

	child.on("exit", (code) => {
		if (code === 0) {
			console.log(`✓ Cleaned up ${pkg}`);
		}
		// Silently ignore failures - package might not be installed
	});
}

console.log("Platform package cleanup completed.");
