package dev.crafleet.console;

import org.bukkit.plugin.java.JavaPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

public final class PaperConsole extends JavaPlugin {
    private Bridge bridge;

    @Override
    public void onEnable() {
        // Use only the public Paper API, including on 1.8.8.
        try {
            getServer().getCommandMap();
        } catch (LinkageError unsupported) {
            getLogger().warning("Console completion is unsupported on this server.");
            return;
        }
        bridge = new Bridge("paper", getDescription().getVersion(), this::complete);
        bridge.start();
    }

    private CompletableFuture<List<Bridge.Suggestion>> complete(Bridge.Request request) {
        CompletableFuture<List<Bridge.Suggestion>> result = new CompletableFuture<>();
        getServer().getScheduler().runTask(this, () -> completeOnMainThread(request, result));
        return result;
    }

    private void completeOnMainThread(
            Bridge.Request request, CompletableFuture<List<Bridge.Suggestion>> result) {
        if (result.isCancelled() || !isEnabled()) {
            return;
        }
        try {
            String prefix = request.prefix();
            int offset = prefix.startsWith("/") ? 1 : 0;
            String command = prefix.substring(offset);
            int start = offset + command.lastIndexOf(' ') + 1;
            List<String> candidates =
                    getServer()
                            .getCommandMap()
                            .tabComplete(getServer().getConsoleSender(), command);
            List<Bridge.Suggestion> suggestions = new ArrayList<>();
            if (candidates != null) {
                for (String text : candidates) {
                    if (text != null) {
                        suggestions.add(new Bridge.Suggestion(start, request.cursor, text));
                    }
                }
            }
            result.complete(suggestions);
        } catch (Throwable failure) {
            result.completeExceptionally(failure);
        }
    }

    @Override
    public void onDisable() {
        if (bridge != null) {
            bridge.close();
        }
    }
}
