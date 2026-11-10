package com.minimalistalliance.desk.deskd.events;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Topics by name. A name ending in {@code :} covers every topic with that prefix. */
public final class TopicRegistry {

    private final Map<String, Topic> topics = new ConcurrentHashMap<>();

    public void register(String name, Topic topic) {
        if (topics.putIfAbsent(name, topic) != null) {
            throw new IllegalStateException("topic registered twice: " + name);
        }
    }

    /** @return the topic, or null if nothing serves this key */
    Topic resolve(String topicKey) {
        int colon = topicKey.indexOf(':');
        return colon < 0 ? topics.get(topicKey) : topics.get(topicKey.substring(0, colon + 1));
    }
}
