package fr.arffornia.playtest;

// SKETCH, NOT BUILT: the shape of the probe mod described in docs/agent-spec.md. It shows where each
// piece hooks into NeoForge 21.1 so the first implementation PR starts from a reviewed design.
//
// The probe is a dev/test-only mod (never in the player pack). On the client it embeds a tiny MCP
// server (JSON-RPC 2.0 over HTTP on 127.0.0.1, bearer token) exposing the tools in agent/tools.json.
// Every handler runs on the render thread via Minecraft.getInstance().execute(...), because the
// client world, screens and input are not thread-safe.

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;
import net.minecraft.client.Minecraft;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLEnvironment;

@Mod(value = "arffornia_playtest", dist = Dist.CLIENT)
public final class PlaytestProbe {
    static final int PORT = Integer.getInteger("arffornia.playtest.port", 25599);

    public PlaytestProbe(IEventBus modBus) {
        // Guard 1: refuse to start in a production pack (Provisioning never ships this jar, this is belt and braces).
        if (FMLEnvironment.production && !Boolean.getBoolean("arffornia.playtest.enable")) return;
        Map<String, Function<Map<String, Object>, Object>> tools = Map.of(
                "observe", Tools::observe,         // screenshot (Screenshot.takeScreenshot -> PNG) + state JSON + widget tree
                "click_widget", Tools::clickWidget, // Screen#children() -> AbstractWidget#onClick, ids from observe
                "slot", Tools::slot,               // MultiPlayerGameMode#handleInventoryMouseClick (what a real click does)
                "input", Tools::input,             // KeyMapping#setDown / KeyMapping.click, MouseHandler for screens
                "look", Tools::look,               // LocalPlayer#lookAt(EntityAnchorArgument.Anchor.EYES, target)
                "use", Tools::use,                 // Minecraft#startUseItem / startAttack, i.e. the vanilla paths
                "command", Tools::command,         // ClientPacketListener#sendCommand; server side refuses on non-test servers
                "time", Tools::time,               // "/tick freeze|step N" + server-side predicate polling (probe server half)
                "scenario", Tools::scenario,       // probe server half: place GameTest structure, gamerules, log marks
                "assert", Tools::assertion);       // evaluates and records into the run report
        start(tools);
    }

    static void start(Map<String, Function<Map<String, Object>, Object>> tools) {
        try {
            HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", PORT), 0);
            String token = Token.loadOrCreate(); // config/arffornia-playtest.toml, 0600
            http.createContext("/mcp", ex -> Mcp.handle(ex, token, (name, args) -> onRenderThread(() -> tools.get(name).apply(args))));
            http.start();
        } catch (Exception e) {
            throw new IllegalStateException("playtest probe could not bind 127.0.0.1:" + PORT, e);
        }
    }

    static <T> T onRenderThread(java.util.function.Supplier<T> s) {
        CompletableFuture<T> f = new CompletableFuture<>();
        Minecraft.getInstance().execute(() -> { try { f.complete(s.get()); } catch (Throwable t) { f.completeExceptionally(t); } });
        return f.join();
    }
}
