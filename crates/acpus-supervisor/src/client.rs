use acpus_runtime_api::{
    AcpusIr, ForkRequest, NodeExecutionState, NodeKey, ReplayResult, RunId, RunState, RunSummary,
    SignalRequest, SupervisorHealth,
};
use reqwest::StatusCode;
use serde::{Serialize, de::DeserializeOwned};

#[derive(Clone, Debug)]
pub struct SupervisorClient {
    endpoint: String,
    http: reqwest::Client,
}

impl SupervisorClient {
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into().trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
        }
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub async fn health(&self) -> Result<SupervisorHealth, SupervisorClientError> {
        self.get_json("/health").await
    }

    pub async fn list_runs(&self) -> Result<Vec<RunSummary>, SupervisorClientError> {
        self.get_json("/runs").await
    }

    pub async fn get_run(&self, run_id: &RunId) -> Result<RunState, SupervisorClientError> {
        self.get_json(&format!("/runs/{run_id}")).await
    }

    pub async fn get_ir(&self, run_id: &RunId) -> Result<AcpusIr, SupervisorClientError> {
        self.get_json(&format!("/runs/{run_id}/ir")).await
    }

    pub async fn signal(
        &self,
        run_id: &RunId,
        node_key: &NodeKey,
        request: &SignalRequest,
    ) -> Result<NodeExecutionState, SupervisorClientError> {
        let response = self
            .http
            .post(self.url(&format!("/runs/{run_id}/signal")))
            .query(&[("key", node_key)])
            .json(&request.payload)
            .send()
            .await?;
        Self::decode_json(response).await
    }

    pub async fn replay(&self, run_id: &RunId) -> Result<ReplayResult, SupervisorClientError> {
        self.post_empty_json(&format!("/runs/{run_id}/replay"))
            .await
    }

    pub async fn fork(
        &self,
        run_id: &RunId,
        request: &ForkRequest,
    ) -> Result<serde_json::Value, SupervisorClientError> {
        self.post_json(&format!("/runs/{run_id}/fork"), request)
            .await
    }

    async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, SupervisorClientError> {
        let response = self.http.get(self.url(path)).send().await?;
        Self::decode_json(response).await
    }

    async fn post_empty_json<T: DeserializeOwned>(
        &self,
        path: &str,
    ) -> Result<T, SupervisorClientError> {
        let response = self.http.post(self.url(path)).send().await?;
        Self::decode_json(response).await
    }

    async fn post_json<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T, SupervisorClientError> {
        let response = self.http.post(self.url(path)).json(body).send().await?;
        Self::decode_json(response).await
    }

    async fn decode_json<T: DeserializeOwned>(
        response: reqwest::Response,
    ) -> Result<T, SupervisorClientError> {
        let status = response.status();
        let bytes = response.bytes().await?;
        if !status.is_success() {
            let body = String::from_utf8_lossy(&bytes).into_owned();
            return Err(SupervisorClientError::Http { status, body });
        }
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.endpoint, path)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SupervisorClientError {
    #[error("supervisor transport error: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("supervisor json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("supervisor http error {status}: {body}")]
    Http { status: StatusCode, body: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn trims_trailing_slashes_from_endpoint() {
        let client = SupervisorClient::new("http://127.0.0.1:1234///");
        assert_eq!(client.endpoint(), "http://127.0.0.1:1234");
    }

    #[tokio::test]
    async fn health_deserializes_response() {
        let endpoint = spawn_response(
            200,
            r#"{"ok":true,"schemaVersion":1,"workspace":"/tmp/acpus","pid":42,"endpoint":"http://127.0.0.1:1","startedAt":"2026-06-26T00:00:00Z","version":"0.1.0","runningCount":0,"activeClients":1}"#,
        )
        .await;
        let client = SupervisorClient::new(endpoint);

        let health = client.health().await.unwrap();

        assert!(health.ok);
        assert_eq!(health.schema_version, 1);
        assert_eq!(health.active_clients, 1);
    }

    #[tokio::test]
    async fn http_errors_preserve_status_and_body() {
        let endpoint = spawn_response(409, r#"{"error":"busy"}"#).await;
        let client = SupervisorClient::new(endpoint);

        let error = client.health().await.unwrap_err();

        let SupervisorClientError::Http { status, body } = error else {
            panic!("expected http error");
        };
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body, r#"{"error":"busy"}"#);
    }

    async fn spawn_response(status: u16, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 1024];
            let _ = stream.read(&mut buffer).await.unwrap();
            let reason = if status == 200 { "OK" } else { "Error" };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{addr}")
    }
}
