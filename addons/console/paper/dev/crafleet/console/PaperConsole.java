package dev.crafleet.console;

import java.util.*;
import java.util.concurrent.*;
import org.bukkit.plugin.java.JavaPlugin;

public final class PaperConsole extends JavaPlugin {
    private Bridge bridge;
    @Override public void onEnable() {
        // Use only the public Paper API, including on 1.8.8.
        try { getServer().getCommandMap(); }
        catch (LinkageError unsupported) { getLogger().warning("Console completion is unsupported on this server."); return; }
        bridge = new Bridge("paper", getDescription().getVersion(), request -> {
            CompletableFuture<List<Bridge.Suggestion>> result = new CompletableFuture<>();
            getServer().getScheduler().runTask(this, () -> {
                if (result.isCancelled() || !isEnabled()) return;
                try {
                    String prefix = request.prefix();
                    int offset = prefix.startsWith("/") ? 1 : 0;
                    String command = prefix.substring(offset);
                    int start = offset + command.lastIndexOf(' ') + 1;
                    List<String> candidates = getServer().getCommandMap().tabComplete(getServer().getConsoleSender(), command);
                    List<Bridge.Suggestion> suggestions = new ArrayList<>();
                    if (candidates != null) for (String text : candidates) {
                        if (text != null) suggestions.add(new Bridge.Suggestion(start, request.cursor, text));
                    }
                    result.complete(suggestions);
                } catch (Throwable failure) { result.completeExceptionally(failure); }
            });
            return result;
        });
        bridge.start();
    }
    @Override public void onDisable() { if (bridge != null) bridge.close(); }
}
