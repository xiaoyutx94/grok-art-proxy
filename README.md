# Grok Imagine

一个基于 Cloudflare Workers 的 Grok 图片/视频生成代理服务。

## 功能特性

- 图片生成 - 支持多种宽高比、NSFW 模式
- 视频合成 - 将图片转换为动态视频
- Token 管理 - 批量导入、导出、状态监控
- 认证保护 - 用户名密码登录
- 一键部署 - Fork 后通过 GitHub Actions 自动部署

## 一键部署

### 前置要求

1. [Cloudflare 账号](https://dash.cloudflare.com/sign-up)
2. GitHub 账号

### 步骤 1: Fork 项目

点击右上角 **Fork** 按钮，将项目 Fork 到你的 GitHub 账号。

### 步骤 2: 获取 Cloudflare 凭证

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 获取 **Account ID**:
   - 进入任意 Workers 项目或点击右侧边栏查看
   - 或访问 `https://dash.cloudflare.com/<account-id>`
3. 创建 **API Token**:
   - 进入 [API Tokens](https://dash.cloudflare.com/profile/api-tokens)
   - 点击 **Create Token**
   - 选择 **Edit Cloudflare Workers** 模板
   - 确保包含以下权限:
     - Account > Workers Scripts > Edit
     - Account > Workers KV Storage > Edit
     - Account > D1 > Edit
   - 创建并复制 Token

### 步骤 3: 配置 GitHub Secrets

进入你 Fork 的仓库 → **Settings** → **Secrets and variables** → **Actions**

添加以下 Secrets:

| Secret 名称 | 说明 | 必填 |
|-------------|------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token | ✅ |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID | ✅ |
| `AUTH_USERNAME` | 登录用户名 | ✅ |
| `AUTH_PASSWORD` | 登录密码 | ✅ |
| `D1_DATABASE_ID` | D1 数据库 ID (首次部署后填写) | ❌ |
| `KV_NAMESPACE_ID` | KV 命名空间 ID (首次部署后填写) | ❌ |

### 步骤 4: 首次部署

1. 进入 **Actions** 标签页
2. 点击 **Deploy to Cloudflare Workers**
3. 点击 **Run workflow**
4. 将 `create_resources` 设置为 `true`
5. 点击 **Run workflow** 执行

首次部署会自动创建 D1 数据库和 KV 命名空间。

### 步骤 5: 保存资源 ID (可选)

首次部署后，在 Actions 日志中找到创建的资源 ID，添加到 GitHub Secrets:
- `D1_DATABASE_ID`
- `KV_NAMESPACE_ID`

这样后续部署会更稳定。

### 步骤 6: 访问应用

部署完成后，访问:
```
https://grok-imagine.<your-account>.workers.dev
```

## 本地开发

### 安装依赖

```bash
npm install
```

### 配置环境变量

创建 `.dev.vars` 文件:

```
AUTH_USERNAME=admin
AUTH_PASSWORD=your-password
```

### 创建本地数据库

```bash
npx wrangler d1 create grok-imagine --local
npx wrangler d1 migrations apply DB --local
```

### 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:8787

## 手动部署

如果不使用 GitHub Actions，可以手动部署:

```bash
# 登录 Cloudflare
npx wrangler login

# 创建 D1 数据库
npx wrangler d1 create grok-imagine

# 创建 KV 命名空间
npx wrangler kv namespace create KV_CACHE

# 更新 wrangler.toml 中的 database_id 和 id

# 执行数据库迁移
npm run db:migrate

# 部署
npm run deploy

# 设置认证密码
echo "your-username" | npx wrangler secret put AUTH_USERNAME
echo "your-password" | npx wrangler secret put AUTH_PASSWORD
```

## 使用说明

### 添加 Token

1. 登录后进入 **令牌管理** 页面
2. 在文本框中粘贴 Token (支持多种格式):
   - 纯 SSO Token (每行一个)
   - JSON 数组格式
   - CSV 格式: `sso,sso_rw,user_id,cf_clearance,name`
3. 点击 **导入数据**

### 生成图片

1. 进入 **图片生成** 页面
2. 输入提示词
3. 选择数量、宽高比、NSFW 模式
4. 点击 **开始生成**

### 生成视频

1. 先生成图片
2. 点击图片下方的 **生成视频** 按钮
3. 输入动作描述
4. 选择时长和分辨率
5. 点击 **生成视频**

## 技术栈

- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV
- **Frontend**: Vanilla JS

## License

MIT
