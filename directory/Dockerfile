FROM ghcr.io/wotbotdev/wot-replay@sha256:a18d110cce750e1d0c36889ade521cb0a43de5011707300ca7d726eec9f7e4f3

COPY directory/wot_directory.py /opt/wotbot-demo-kit/wot_directory.py
COPY directory/manifest_directory.py /opt/wotbot-demo-kit/manifest_directory.py

WORKDIR /opt/wotbot-demo-kit
ENV PYTHONPATH=/opt/wotbot-demo-kit
ENTRYPOINT ["python", "-m", "uvicorn", "manifest_directory:create_app", "--factory", "--host", "0.0.0.0", "--port", "9000"]
CMD []
