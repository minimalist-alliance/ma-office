package main

import (
	"errors"
	"runtime"
	"syscall"
	"unsafe"
)

// restrictSockets installs a seccomp filter on every thread (TSYNC) that lets socket() make IPv4 TCP sockets only, with
// EPERM for any other family or type, and kills the process on a syscall of another architecture. The demux holds
// CAP_NET_RAW for IP_TRANSPARENT alone; with this, the capability can't open a raw or packet socket. systemd's
// RestrictAddressFamilies=AF_INET (desk-ice-demux.service) is the same rule for families from outside.

const (
	seccompSetModeFilter  = 1
	seccompFilterFlagSync = 1 // SECCOMP_FILTER_FLAG_TSYNC
	retAllow              = 0x7fff0000
	retErrno              = 0x00050000
	retKillProcess        = 0x80000000
	afInet                = 2
	sockStream            = 1
	sockTypeMask          = 0xf
	prSetNoNewPrivs       = 38 // PR_SET_NO_NEW_PRIVS

	bpfLdWAbs = 0x20 // BPF_LD | BPF_W | BPF_ABS
	bpfJeqK   = 0x15 // BPF_JMP | BPF_JEQ | BPF_K
	bpfAndK   = 0x54 // BPF_ALU | BPF_AND | BPF_K
	bpfRetK   = 0x06 // BPF_RET | BPF_K

	offNr   = 0  // struct seccomp_data: int nr
	offArch = 4  // __u32 arch
	offArg0 = 16 // __u64 args[6], little-endian: the low half first
	offArg1 = 24
)

func filterProgram() []syscall.SockFilter {
	st := func(code uint16, k uint32) syscall.SockFilter { return syscall.SockFilter{Code: code, K: k} }
	jeq := func(k uint32, jt, jf uint8) syscall.SockFilter {
		return syscall.SockFilter{Code: bpfJeqK, Jt: jt, Jf: jf, K: k}
	}

	return []syscall.SockFilter{
		st(bpfLdWAbs, offArch),
		jeq(auditArch, 1, 0),
		st(bpfRetK, retKillProcess),
		st(bpfLdWAbs, offNr),
		jeq(sysSocket, 1, 0),
		st(bpfRetK, retAllow),
		st(bpfLdWAbs, offArg0),
		jeq(afInet, 1, 0),
		st(bpfRetK, retErrno|uint32(syscall.EPERM)),
		st(bpfLdWAbs, offArg1),
		st(bpfAndK, sockTypeMask),
		jeq(sockStream, 1, 0),
		st(bpfRetK, retErrno|uint32(syscall.EPERM)),
		st(bpfRetK, retAllow),
	}
}

func restrictSockets() error {
	if sysSeccomp == 0 {
		return errors.New("no seccomp filter for this architecture")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if _, _, e := syscall.RawSyscall6(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0, 0, 0, 0); e != 0 {
		return e
	}
	prog := filterProgram()
	fprog := syscall.SockFprog{Len: uint16(len(prog)), Filter: &prog[0]}
	if _, _, e := syscall.RawSyscall(sysSeccomp, seccompSetModeFilter, seccompFilterFlagSync, uintptr(unsafe.Pointer(&fprog))); e != 0 {
		return e
	}
	runtime.KeepAlive(prog)

	return nil
}
