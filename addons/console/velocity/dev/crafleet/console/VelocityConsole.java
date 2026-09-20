package dev.crafleet.console;

import com.google.inject.Inject;
import com.velocitypowered.api.command.CommandManager;
import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.event.proxy.ProxyShutdownEvent;
import com.velocitypowered.api.proxy.ProxyServer;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

public final class VelocityConsole {
    private final ProxyServer server;
    private Bridge bridge;

    @Inject
    public VelocityConsole(ProxyServer server) {
        this.server = server;
    }

    @Subscribe
    public void initialize(ProxyInitializeEvent event) {
        try {
            CommandManager.class.getMethod(
                    "offerBrigadierSuggestions", CommandSource.class, String.class);
        } catch (ReflectiveOperationException unsupported) {
            return;
        }
        bridge =
                new Bridge(
                        "velocity",
                        getClass().getPackage().getImplementationVersion(),
                        this::complete);
        bridge.start();
    }

    private CompletableFuture<List<Bridge.Suggestion>> complete(Bridge.Request request) {
        String prefix = request.prefix();
        int offset = prefix.startsWith("/") ? 1 : 0;
        return server.getCommandManager()
                .offerBrigadierSuggestions(
                        server.getConsoleCommandSource(), prefix.substring(offset))
                .thenApply(
                        candidates -> {
                            List<Bridge.Suggestion> result = new ArrayList<>();
                            candidates
                                    .getList()
                                    .forEach(
                                            candidate -> {
                                                int start =
                                                        offset + candidate.getRange().getStart();
                                                int end = offset + candidate.getRange().getEnd();
                                                result.add(
                                                        new Bridge.Suggestion(
                                                                start, end, candidate.getText()));
                                            });
                            return result;
                        });
    }

    @Subscribe
    public void shutdown(ProxyShutdownEvent event) {
        if (bridge != null) {
            bridge.close();
        }
    }
}
