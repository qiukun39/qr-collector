package com.qk.packdesk;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 局域网里找装箱台电脑端。
 *
 * 为什么要写原生：浏览器和 WebView 发不了 UDP 广播。电脑换了 IP 之后
 * （路由器重启、换 WiFi、DHCP 续租失败），手机里存的地址就失效了，
 * 没有这个就只能让人重新扫一次码。
 *
 * 协议见 packdesk-desktop/internal/server/discovery.go：
 *   发  {"protocol":"packdesk","v":1,"action":"discover"}   广播到 UDP 5179
 *   收  {"protocol":"packdesk","v":1,"action":"announce","nodeId":…,"httpPort":…}
 */
@CapacitorPlugin(name = "LanDiscover")
public class LanDiscoverPlugin extends Plugin {

    private static final int PORT = 5179;
    private static final String PROTO = "packdesk";
    private static final int VERSION = 1;

    @PluginMethod
    public void discover(PluginCall call) {
        int timeoutMs = call.getInt("timeoutMs", 1200);
        String wantNodeId = call.getString("nodeId", "");

        new Thread(() -> {
            DatagramSocket sock = null;
            try {
                sock = new DatagramSocket();
                sock.setBroadcast(true);
                sock.setSoTimeout(Math.max(200, timeoutMs));

                byte[] req = new JSONObject()
                        .put("protocol", PROTO).put("v", VERSION).put("action", "discover")
                        .toString().getBytes("UTF-8");

                // 往全局广播地址和每个网卡自己的广播地址各发一份。
                // 有些机型/路由器对 255.255.255.255 不转发，只认子网广播地址
                for (InetAddress target : broadcastTargets()) {
                    try {
                        sock.send(new DatagramPacket(req, req.length, target, PORT));
                    } catch (Exception ignored) {
                    }
                }

                Set<String> seen = new LinkedHashSet<>();
                JSArray hosts = new JSArray();
                long deadline = System.currentTimeMillis() + Math.max(200, timeoutMs);
                while (System.currentTimeMillis() < deadline) {
                    byte[] buf = new byte[1024];
                    DatagramPacket pkt = new DatagramPacket(buf, buf.length);
                    try {
                        sock.receive(pkt);
                    } catch (SocketTimeoutException e) {
                        break;
                    }
                    try {
                        JSONObject m = new JSONObject(new String(pkt.getData(), 0, pkt.getLength(), "UTF-8"));
                        if (!PROTO.equals(m.optString("protocol")) || m.optInt("v") != VERSION
                                || !"announce".equals(m.optString("action"))) {
                            continue;   // 局域网里什么广播都有，不是我们的就跳过
                        }
                        String nodeId = m.optString("nodeId", "");
                        int httpPort = m.optInt("httpPort", 0);
                        if (nodeId.isEmpty() || httpPort <= 0 || httpPort > 65535) continue;
                        // 指定了要找哪台就只收那台的，别把别人的电脑也报上去
                        if (!wantNodeId.isEmpty() && !wantNodeId.equalsIgnoreCase(nodeId)) continue;
                        String ip = pkt.getAddress().getHostAddress();
                        String url = "http://" + ip + ":" + httpPort;
                        if (!seen.add(url)) continue;

                        JSObject h = new JSObject();
                        h.put("host", url);
                        h.put("nodeId", nodeId);
                        h.put("nodeName", m.optString("nodeName", ""));
                        hosts.put(h);
                    } catch (Exception ignored) {
                    }
                }

                JSObject ret = new JSObject();
                ret.put("hosts", hosts);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("找不到电脑端：" + e.getMessage());
            } finally {
                if (sock != null) sock.close();
            }
        }).start();
    }

    /** 全局广播 + 各网卡的子网广播地址。 */
    private List<InetAddress> broadcastTargets() {
        List<InetAddress> out = new ArrayList<>();
        try {
            out.add(InetAddress.getByName("255.255.255.255"));
        } catch (Exception ignored) {
        }
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            for (NetworkInterface ni : Collections.list(ifs)) {
                if (ni.isLoopback() || !ni.isUp()) continue;
                for (java.net.InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress b = ia.getBroadcast();
                    if (b != null) out.add(b);
                }
            }
        } catch (Exception ignored) {
        }
        return out;
    }
}
