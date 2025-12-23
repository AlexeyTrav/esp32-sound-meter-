#include <driver/i2s.h>
#include <math.h>

#define I2S_PORT I2S_NUM_0

#define PIN_BCLK 32   // SCK
#define PIN_LRCL 25   // WS
#define PIN_DOUT 33   // SD

#define SAMPLE_RATE 44100
#define BLOCK_SIZE 512   // сколько сэмплов считаем за раз

// 24-bit full scale (signed): -8388608..8388607
static const float FULL_SCALE_24 = 8388608.0f;

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("INMP441 simple volume test (corridor-style dB)");

  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S_MSB,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = 256,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pin_config = {
    .bck_io_num = PIN_BCLK,
    .ws_io_num = PIN_LRCL,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = PIN_DOUT
  };

  i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_PORT, &pin_config);
  i2s_zero_dma_buffer(I2S_PORT);

  Serial.println("Speak or clap near mic...");
}

void loop() {
  static int32_t samples[BLOCK_SIZE];
  size_t bytes_read = 0;

  i2s_read(I2S_PORT, samples, sizeof(samples), &bytes_read, portMAX_DELAY);
  int count = bytes_read / sizeof(int32_t);

  if (count == 0) return;

  // считаем RMS (громкость) из 24-bit данных INMP441 в 32-bit фрейме
  double sumsq = 0.0;

  for (int i = 0; i < count; i++) {
    // INMP441: 24-bit MSB-aligned inside 32-bit word
    int32_t s = samples[i] >> 8;            // сдвигаем вниз на 24 бита
    if (s & 0x00800000) s |= 0xFF000000;    // sign-extend 24-bit

    float sf = (float)s;
    sumsq += (double)sf * (double)sf;
  }

  float rms = sqrt(sumsq / (double)count);

  // dB расчет как в "коридорном" коде: 20*log10(rms/fullscale) + 90
  float db_rms = 0.0f;
  if (rms > 0.0f) {
    db_rms = 20.0f * log10f(rms / FULL_SCALE_24) + 90.0f;
  }
  if (db_rms < 0.0f) db_rms = 0.0f;

  Serial.println(db_rms, 1);

  delay(100); // 10 раз в секунду
}
