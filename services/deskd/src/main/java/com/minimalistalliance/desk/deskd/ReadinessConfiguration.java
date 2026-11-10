package com.minimalistalliance.desk.deskd;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
class ReadinessConfiguration {

    @Bean
    ReadinessReporter readinessReporter() {
        return new ReadinessReporter();
    }
}
