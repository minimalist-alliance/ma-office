#!/usr/bin/perl
# A stand-in for ADR 0097's desk-parse sandbox dispatcher, for tests and measurements only: desk-svc's
# -accept <socket> -accept-mode 0660 -peer-uid <uid> -max-conn 1 -deadline-sec 35 -conn-stdio -clean -- <argv>,
# in Perl because the JRE image's base has it and has no Go. On a desk it's desk-svc; nothing here ships to one.
#
#   parse-standin.pl <socket> <peer uid, or -1 for any> <argv...>
#
# Per connection: a peer of another uid gets "err denied", a second at once "err busy" (both as desk-svc writes them,
# at once, the request unread); otherwise argv runs with the connection as its stdin and stdout, its stderr to
# /dev/null, an empty environment and a process group of its own, killed 35 s after it starts. When it ends, and when
# running as process 1 (in a container), every other process is killed (-clean). Logs one line per connection to stderr,
# never anything read.
use strict;
use warnings;
use Socket qw(AF_UNIX SOCK_STREAM SOL_SOCKET SO_PEERCRED pack_sockaddr_un);
use POSIX qw(setpgid _exit :sys_wait_h);

my ($path, $peer_uid, @argv) = @ARGV;
die "usage: parse-standin.pl <socket> <peer uid> <argv...>\n" unless defined $path && defined $peer_uid && @argv;
my $deadline = 35;
$| = 1;

unlink $path;
socket(my $server, AF_UNIX, SOCK_STREAM, 0) or die "socket: $!";
my $old = umask 0177;
bind($server, pack_sockaddr_un($path)) or die "bind $path: $!";
umask $old;
chmod 0660, $path or die "chmod: $!";
listen($server, 8) or die "listen: $!";
print STDERR "parse-standin: accepting on $path (peer uid $peer_uid, one at a time)\n";

my $worker = 0;      # the running worker's pid, or 0
my $started = 0;
$SIG{TERM} = sub { kill 'KILL', -$worker if $worker; exit 0 };

sub reap {
    while ((my $pid = waitpid(-1, WNOHANG)) > 0) {
        if ($pid == $worker) {
            $worker = 0;
            if ($$ == 1) {
                kill 'KILL', -1;    # -clean: nothing a parse started outlives it
                1 while waitpid(-1, WNOHANG) > 0;
            }
        }
    }
}

while (1) {
    reap();
    if ($worker && time - $started >= $deadline) {
        kill 'KILL', -$worker;
    }
    my $rin = '';
    vec($rin, fileno($server), 1) = 1;
    next unless select(my $rout = $rin, undef, undef, 0.2) > 0;
    my $conn;
    accept($conn, $server) or next;
    my ($pid, $uid) = unpack('lll', getsockopt($conn, SOL_SOCKET, SO_PEERCRED) // pack('lll', 0, -2, -2));
    if ($peer_uid >= 0 && $uid != $peer_uid) {
        syswrite($conn, "err denied\n");
        close $conn;
        print STDERR "parse-standin: denied a peer of uid $uid\n";
        next;
    }
    # The last worker's socket closes as it exits, a moment before it can be reaped, so desk-agent's next file can
    # arrive first: reap again, briefly, before calling it busy (desk-svc's reaper goroutine has the same window).
    for (1 .. 10) {
        reap();
        last unless $worker;
        select(undef, undef, undef, 0.005);
    }
    if ($worker) {
        syswrite($conn, "err busy\n");
        close $conn;
        print STDERR "parse-standin: busy\n";
        next;
    }
    my $child = fork();
    if (!defined $child) {
        close $conn;
        next;
    }
    if ($child == 0) {
        setpgid(0, 0);
        open(STDIN, '<&', $conn) or _exit(70);
        open(STDOUT, '>&', $conn) or _exit(70);
        open(STDERR, '>', '/dev/null') or _exit(70);
        close $conn;
        close $server;
        %ENV = ();
        exec { $argv[0] } @argv;
        _exit(127);
    }
    close $conn;
    $worker = $child;
    $started = time;
    print STDERR "parse-standin: a worker for a peer of uid $uid\n";
}
