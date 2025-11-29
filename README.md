# AI Code Reviewer

An AI-powered multi-agent system for automated code review using LangGraph and Neo4j as a AST knowledge graph. The steps are only neccesary if used local without github action

## Prerequisites

- **Node.js** >= 18
- **Docker** & **Docker Compose**
- **Semgrep** (for security scanning)
- **Grep** (for repo text search)

### Install Semgrep

```bash
# Using pip
pip install semgrep
```

### Install Grep if not already installed

## Setup

### 1. Start Neo4j Database

```bash
docker compose up -d
```

This starts a Neo4j instance with APOC plugins on:
- Browser: http://localhost:7474
- Bolt: bolt://localhost:7687
- Credentials: `neo4j` / `password123`

### 2. Install Dependencies

```bash
npm install --legacy-peer-deps
```

### 3. Configure Environment

Create a `.env` file in the project root:

```env
# === LLM API Keys (at least one required) ===
GOOGLE_API_KEY=your_google_api_key
# MISTRAL_API_KEY=your_mistral_api_key
# OPENROUTER_API_KEY=your_openrouter_api_key
# OPENAI_API_KEY=your_openai_api_key
# ANTHROPIC_API_KEY=your_antropic_api_key

# AZURE_OPENAI_API_KEY=your_azure_key
# AZURE_OPENAI_API_INSTANCE_NAME=your_instance
# AZURE_OPENAI_API_ENDPOINT=https://your-instance.cognitiveservices.azure.com/
# AZURE_OPENAI_API_VERSION=2024-12-01-preview
# AZURE_OPENAI_API_DEPLOYMENT_NAME=gpt-4o-mini
# AZURE_OPENAI_API_EMBEDDINGS_DEPLOYMENT_NAME=text-embedding-3-small

# === Neo4j Database ===
NEO4J_URL=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password123

# === Repository Configuration ===
REPO_PATH=/absolute/path/to/target/repository
PR_HEAD_SHA=commit_sha_of_pr_head
PR_BASE_BRANCH=commit_sha_or_branch_of_base

# === LangSmith Tracing (optional) ===
# LANGSMITH_TRACING=true
# LANGSMITH_ENDPOINT=https://api.smith.langchain.com
# LANGSMITH_API_KEY=your_langsmith_key
# LANGSMITH_PROJECT=code-reviewer

# === Logging ===
NODE_ENV=development
LOG_LEVEL=debug
```

## Usage

### Run Code Review

```bash
npm run dev
```