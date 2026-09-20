package dev.crafleet.console;

import com.google.inject.Inject;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.command.CommandManager;
import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.event.proxy.ProxyShutdownEvent;
import java.util.*;

public final class VelocityConsole {
    private final ProxyServer server;
    private Bridge bridge;
    @Inject public VelocityConsole(ProxyServer server) { this.server = server; }
    @Subscribe public void initialize(ProxyInitializeEvent event) {
        try { CommandManager.class.getMethod("offerBrigadierSuggestions", CommandSource.class, String.class); }
        catch (ReflectiveOperationException unsupported) { return; }
        bridge = new Bridge("velocity", getClass().getPackage().getImplementationVersion(), request -> {
            String prefix = request.prefix();
            int offset = prefix.startsWith("/") ? 1 : 0;
            return server.getCommandManager().offerBrigadierSuggestions(server.getConsoleCommandSource(), prefix.substring(offset)).thenApply(candidates -> {
                List<Bridge.Suggestion> result = new ArrayList<>();
                candidates.getList().forEach(candidate -> result.add(new Bridge.Suggestion(offset + candidate.getRange().getStart(), offset + candidate.getRange().getEnd(), candidate.getText())));
                return result;
            });
        });
        bridge.start();
    }
    @Subscribe public void shutdown(ProxyShutdownEvent event) { if (bridge != null) bridge.close(); }
}
