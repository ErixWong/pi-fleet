使用 Resend 搭建验证码和 App 系统通知服务，可以按照以下步骤逐步操作：

---

### Phase 1: Resend 账号与 API 准备

* [ ] **注册 Resend 账号**

* 访问 [resend.com](https://resend.com) 注册账号（可直接用 GitHub / Google 账号登录）。

* [ ] **创建 API Key**

* 进入控制台侧边栏 **API Keys** -> 点击 **Create API Key**。
* 名称可填 `App-OTP-Production`，权限选择 **Full Access**（或仅限定发信权限 **Sending Access**）。
* **重要**：生成的 API Key 仅显示一次，复制保存到本地环境变量文件（如 `.env`）中。

---

### Phase 2: 域名绑定与 DNS 解析（防进垃圾箱的关键）

* [ ] **在 Resend 中添加域名**

* 进入侧边栏 **Domains** -> 点击 **Add Domain**，输入你的根域名（如 `yourdomain.com`）或发信子域名（如 `mail.yourdomain.com` 或 `notify.yourdomain.com`）。
* *建议*：推荐使用子域名（如 `notify.yourdomain.com`），不仅能隔离主站域名权重，以后如果做系统拆分也更容易管理。

* [ ] **前往 DNS 服务商配置解析记录**

* 打开你的 DNS 管理后台（如 Cloudflare、阿里云、腾讯云、GoDaddy 等），根据 Resend 控制台给出的提示，添加以下几条记录：

1. **MX 记录**：用于 Resend 的域名所有权验证（或是特定退信处理）。
2. **TXT 记录 (SPF)**：告知接收方服务器 Resend 有权代表你的域名发信。
3. **TXT 记录 (DKIM)**：邮件加密数字签名（记录名通常带有 `resend._domainkey`）。

* [ ] **配置防拦截记录（DMARC，强推）**

* 在 DNS 增加一条 TXT 记录：
* **Name / 主机记录**：`_dmarc`
* **Value / 记录值**：`v=DMARC1; p=none;`（起步设为 `p=none` 观察即可）。

* [ ] **验证 DNS 生效**

* 在 Resend Domains 页面点击 **Verify**。一般 1~5 分钟生效（部分服务商最长需 24 小时）。状态显示 **Verified** 即算完成。

---

### Phase 3: 本地应用代码集成

* [ ] **配置环境变量**

* 在你的后端项目中配置环境变量（切勿硬编码在代码中）：

```env
RESEND_API_KEY=re_123456789...

```

* [ ] **安装 Resend SDK**

* **Node.js / TypeScript**: `npm install resend`
* **Python**: `pip install resend`
* **Go**: `go get [github.com/resend/resend-go/v2](https://github.com/resend/resend-go/v2)`

* [ ] **编写发信核心逻辑（以 Node.js 为例）**

* 发件人地址格式必须为 `任意名称 <xxxx@你的域名.com>`。

```javascript
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendOTP(toEmail, otpCode) {
  const { data, error } = await resend.emails.send({
    from: 'Auth <no-reply@yourdomain.com>', // 替换为你的已验证域名
    to: [toEmail],
    subject: `${otpCode} 是你的验证码`,
    html: `<p>你的登录验证码是 <strong>${otpCode}</strong>，5分钟内有效。</p>`,
  });

  if (error) {
    console.error('发送验证码失败:', error);
    return false;
  }
  return true;
}

```

* [ ] **在本地跑一次接口调试**

* 触发发信函数，并在 Resend 控制台侧边栏 **Logs** 确认邮件状态是否变为 **Delivered**。

---

### Phase 4: 关于“我能不能收到邮件？”（收件与入站支持）

**答案是：可以收，但 Resend 的收发逻辑是分开的。**

1. **默认情况下（只发不收）**：

* Resend 本质是一个**事务发信平台**（Outbound），你发出去的邮件，如果用户直接点击“回复”，默认会回复到你设置的 `from` 地址（比如 `no-reply@yourdomain.com`）。
* 如果你没配置收信服务，发到这个邮箱的邮件就会投递失败被退回。

2. **如果想接收用户回复的邮件，有 2 种常用解法**：

* **方案 A：设置 `reply_to` 参数（最简单）**
* 在调用 API 发信时，指定 `reply_to` 为你的私人邮箱或客服邮箱：

```javascript
await resend.emails.send({
  from: 'Auth <no-reply@yourdomain.com>',
  reply_to: 'support@yourdomain.com', // 或者你的个人 Gmail
  to: [toEmail],
  // ...
});

```

* 这样用户点“回复”时，会自动发送到你指定的能正常收信的邮箱里。
* **方案 B：使用免费的域名邮件转发服务（推荐）**
* 如果你用的是 **Cloudflare DNS**，可以直接开启 **Cloudflare Email Routing**（免费）。
* 将 `support@yourdomain.com` 或 `no-reply@yourdomain.com` 接收到的邮件，**无缝免费转发到你的个人 Gmail /  QQ 邮箱**。
* 这样既能免去买企业邮局的钱，又能用自己的域名收信。
* **方案 C：使用 Resend 官方的 Webhooks / Inbound 方案**
* Resend 也支持 **Inbound Email**（接收邮件并转化为 Webhook 调你的后端 API）。如果你想在 App 后端用代码解析用户回复的内容，可以开启这个功能。

---
