/*
 * 小羊签到 for Loon
 * 通用定时 HTTP 签到脚本。不会输出 Header、Cookie、Body 或响应正文。
 */

(function () {
  "use strict";

  var args = typeof $argument === "object" && $argument ? $argument : {};
  var prefix = detectTaskPrefix(args);
  var isManual = typeof $environment !== "undefined";
  var today = localDateKey(new Date());
  var task = { name: "签到任务", url: "" };
  var stateKey;

  try {
    task = readTask(args, prefix);
    validate(task, args);
    stateKey = "xiaoyang.checkin.lastSuccess." + stableHash(task.name + "|" + task.url);
  } catch (error) {
    finish(false, task.name, "配置错误：" + safeMessage(error), true);
    return;
  }

  if (!isManual && $persistentStore.read(stateKey) === today) {
    console.log("[小羊签到] " + task.name + " 今日已成功，跳过重复执行");
    $done();
    return;
  }

  var request = {
    url: task.url,
    timeout: task.timeoutMs,
    headers: task.headers,
    "auto-redirect": true,
    "auto-cookie": true
  };

  if (task.body !== null) {
    request.body = task.body;
  }

  console.log("[小羊签到] 开始：" + task.name + "，方式：" + task.method);
  $httpClient[task.method.toLowerCase()](request, function (error, response, data) {
    if (error) {
      finish(false, task.name, "网络错误：" + safeMessage(error), true);
      return;
    }

    var status = response && Number(response.status);
    var body = typeof data === "string" ? data : "";
    var result = evaluate(status, body, task);

    if (result.ok) {
      $persistentStore.write(today, stateKey);
    }

    finish(result.ok, task.name, result.message, isManual);
  });

  function detectTaskPrefix(source) {
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i += 1) {
      var match = keys[i].match(/^(t\d+)_url$/);
      if (match) return match[1];
    }
    return "t1";
  }

  function readTask(source, p) {
    var method = stringValue(source[p + "_method"], "GET").toUpperCase();
    var bodyType = stringValue(source[p + "_body_type"], "无");
    var rawBody = stringValue(source[p + "_body"], "");
    var headers = parseObject(stringValue(source[p + "_headers"], "{}"), "Headers");

    if (bodyType === "JSON") {
      if (rawBody.trim()) JSON.parse(rawBody);
      setHeaderIfMissing(headers, "Content-Type", "application/json; charset=utf-8");
    } else if (bodyType === "表单") {
      setHeaderIfMissing(headers, "Content-Type", "application/x-www-form-urlencoded; charset=utf-8");
    } else if (bodyType === "原始文本") {
      setHeaderIfMissing(headers, "Content-Type", "text/plain; charset=utf-8");
    }

    return {
      name: stringValue(source[p + "_name"], "未命名签到"),
      method: method,
      url: stringValue(source[p + "_url"], "").trim(),
      headers: headers,
      body: bodyType === "无" || method === "GET" ? null : rawBody,
      success: stringValue(source[p + "_success"], ""),
      already: stringValue(source[p + "_already"], ""),
      failure: stringValue(source[p + "_failure"], ""),
      notifyMode: stringValue(source.notify_mode, "仅失败"),
      allowHttp: Boolean(source.allow_http),
      timeoutMs: clamp(Number(source.timeout_seconds) || 15, 3, 50) * 1000
    };
  }

  function validate(item) {
    if (!item.url) throw new Error("签到链接为空");
    if (!/^https?:\/\//i.test(item.url)) throw new Error("链接必须以 https:// 或 http:// 开头");
    if (!item.allowHttp && !/^https:\/\//i.test(item.url)) throw new Error("非 HTTPS 链接已被安全设置阻止");
    if (["GET", "POST", "PUT", "PATCH", "DELETE"].indexOf(item.method) < 0) {
      throw new Error("不支持的请求方式");
    }
  }

  function evaluate(status, body, item) {
    if (!status || status < 200 || status >= 300) {
      return { ok: false, message: "HTTP " + (status || "无响应") };
    }
    if (item.failure && body.indexOf(item.failure) !== -1) {
      return { ok: false, message: "响应命中失败关键字（HTTP " + status + "）" };
    }
    if (item.already && body.indexOf(item.already) !== -1) {
      return { ok: true, message: "今日已经签到（HTTP " + status + "）" };
    }
    if (item.success && body.indexOf(item.success) === -1) {
      return { ok: false, message: "未找到成功关键字（HTTP " + status + "）" };
    }
    return { ok: true, message: "签到成功（HTTP " + status + "）" };
  }

  function finish(ok, name, message, forceNotify) {
    var mode = stringValue(args.notify_mode, "仅失败");
    console.log("[小羊签到] " + name + "：" + message);
    if (forceNotify || mode === "全部结果" || (mode === "仅失败" && !ok)) {
      $notification.post("小羊签到", name, (ok ? "✅ " : "❌ ") + message);
    }
    $done();
  }

  function parseObject(text, label) {
    if (!text.trim()) return {};
    var value;
    try {
      value = JSON.parse(text);
    } catch (_) {
      throw new Error(label + " 不是有效 JSON");
    }
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") {
      throw new Error(label + " 必须是 JSON 对象");
    }
    Object.keys(value).forEach(function (key) {
      value[key] = String(value[key]);
    });
    return value;
  }

  function setHeaderIfMissing(headers, name, value) {
    var lower = name.toLowerCase();
    var exists = Object.keys(headers).some(function (key) {
      return key.toLowerCase() === lower;
    });
    if (!exists) headers[name] = value;
  }

  function localDateKey(date) {
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function stableHash(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function stringValue(value, fallback) {
    return value === null || typeof value === "undefined" ? fallback : String(value);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function safeMessage(error) {
    var message = error && error.message ? error.message : String(error || "未知错误");
    return message.replace(/[\r\n]+/g, " ").slice(0, 160);
  }
})();
