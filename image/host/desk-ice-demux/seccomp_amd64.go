package main

// The tests' architecture (the build boxes): the host is arm64.
const (
	sysSeccomp = 317        // amd64's seccomp(2)
	sysSocket  = 41         // amd64's socket(2)
	auditArch  = 0xC000003E // AUDIT_ARCH_X86_64
)
