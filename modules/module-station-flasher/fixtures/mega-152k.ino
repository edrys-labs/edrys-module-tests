// e2e:mega-huge  more than 128 KB of flash, so pages above 0x10000 are written
const uint8_t a[30000] PROGMEM = {1};
const uint8_t b[30000] PROGMEM = {2};
const uint8_t c[30000] PROGMEM = {3};
const uint8_t d[30000] PROGMEM = {4};
const uint8_t e[30000] PROGMEM = {5};
volatile uint16_t i = 0;
void setup() { Serial.begin(9600); }
void loop() {
  uint8_t sum = pgm_read_byte(&a[i]) + pgm_read_byte_far(pgm_get_far_address(b) + i) + pgm_read_byte_far(pgm_get_far_address(c) + i) + pgm_read_byte_far(pgm_get_far_address(d) + i) + pgm_read_byte_far(pgm_get_far_address(e) + i);
  Serial.print("mega-big ");
  Serial.println(sum);
  delay(500);
}
