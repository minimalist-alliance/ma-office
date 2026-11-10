package com.minimalistalliance.desk.deskd.session;

import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** A one-time timer: a parked virtual thread, cancelled by interrupting it. */
final class OneShot {

    private static final Logger log = LoggerFactory.getLogger(OneShot.class);

    private OneShot() {}

    static Thread after(Duration delay, Runnable task) {
        return Thread.ofVirtual().name("session-timer").start(() -> {
            try {
                if (!delay.isNegative()) {
                    Thread.sleep(delay);
                }
            } catch (InterruptedException e) {
                return;
            }
            try {
                task.run();
            } catch (RuntimeException e) {
                log.error("session timer failed: {}", e.getClass().getName());
            }
        });
    }
}
