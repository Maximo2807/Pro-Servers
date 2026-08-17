// database/migrations/2026_08_16_000005_create_server_user_table.php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void {
        Schema::create('server_user', function (Blueprint $table) {
            $table->id();
            $table->foreignId('server_id')->constrained('servers')->cascadeOnDelete();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->json('permissions')->nullable(); // ['power_manage', 'console_read', 'console_write', 'file_edit']
            $table->timestamps();

            $table->unique(['server_id', 'user_id']);
        });
    }

    public function down(): void {
        Schema::dropIfExists('server_user');
    }
};